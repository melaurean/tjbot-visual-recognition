const config = require('./config.js')
const exec = require('child_process').exec;
const fs = require('fs');
const mic = require('mic');
const probe = require('node-ffprobe');
const raspiCam = require('raspicam');

const SpeechToTextV1 = require('watson-developer-cloud/speech-to-text/v1');
const VisualRecognitionV3 = require('watson-developer-cloud/visual-recognition/v3');
const ToneAnalyzerV3 = require('watson-developer-cloud/tone-analyzer/v3');
const ConversationV1 = require('watson-developer-cloud/conversation/v1');
const TextToSpeechV1 = require('watson-developer-cloud/text-to-speech/v1');

const attentionWord = config.attentionWord;

/******************************************************************************
* Create Watson Services
*******************************************************************************/
const speechToText = new SpeechToTextV1({
  username: config.STTUsername,
  password: config.STTPassword,
  version: 'v1'
});

const visualRecognition = new VisualRecognitionV3({
  api_key: config.vrApiKey,
  version_date: '2016-05-19'
});

const toneAnalyzer = new ToneAnalyzerV3({
  username: config.ToneUsername,
  password: config.TonePassword,
  version: 'v3',
  version_date: '2016-05-19'
});

const conversation = new ConversationV1({
  username: config.ConUsername,
  password: config.ConPassword,
  version: 'v1',
  version_date: '2016-07-11'
});

const textToSpeech = new TextToSpeechV1({
  username: config.TTSUsername,
  password: config.TTSPassword,
  version: 'v1'
});

/******************************************************************************
* Initialize Variables
*******************************************************************************/
let monster = '';
let pauseDuration = 0;
let startDialog = false;
let context = {};
let watsonResponse = '';
let ms = (new Date()).getTime().toString();
let imageFile = config.imagePath + "image_" + ms + ".jpg";

/******************************************************************************
* Configuring the Microphone
*******************************************************************************/
const micParams = { 
  rate: 44100, 
  channels: 2, 
  debug: false, 
  exitOnSilence: 6
}
const micInstance = mic(micParams);
const micInputStream = micInstance.getAudioStream();
micInputStream.on('pauseComplete', ()=> {
  console.log('Microphone paused for', pauseDuration, 'seconds.');
  setTimeout(function() {
    micInstance.resume();
    console.log('Microphone resumed.')
  }, Math.round(pauseDuration * 1000)); //Stop listening when speaker is talking
});

micInstance.start();
console.log('TJ is listening, you may speak now.');

/******************************************************************************
* Configure Camera
*******************************************************************************/
const camera = new raspiCam({
  mode: "photo",
  width: 320,
  height: 240,
  quality: 20,
  output: imageFile,
  encoding: "jpg",
  timeout: 0 // take the picture immediately
});

const formatTimestamp = (timestamp) => {
  let date = new Date(timestamp);
  let hours = date.getHours();
  let minutes = "0" + date.getMinutes();
  let seconds = "0" + date.getSeconds();
  return hours + ':' + minutes.substr(-2) + ':' + seconds.substr(-2);
}

camera.on("start", (err, timestamp) => {
  console.log("photo started at " + formatTimestamp(timestamp) );
});

camera.on("read", (err, timestamp, filename) => {
  console.log("photo image captured with filename: " + filename );

  recognizeCharacter(imageFile).then((character) => {
    console.log(character);
    monster = character;
  });
  camera.stop();
});

camera.on("exit", (timestamp) => {
  console.log("photo child process has exited at " + formatTimestamp(timestamp));
});

/******************************************************************************
* Speech To Text
*******************************************************************************/
const textStream = micInputStream.pipe(
  speechToText.createRecognizeStream({
    content_type: 'audio/l16; rate=44100; channels=2',
  })).setEncoding('utf8');

/******************************************************************************
* Get Emotional Tone
*******************************************************************************/
const getEmotion = (text) => {
  return new Promise((resolve) => {
    let maxScore = 0;
    let emotion = null;
    toneAnalyzer.tone({text: text}, (err, tone) => {
      let tones = tone.document_tone.tone_categories[0].tones;
      for (let i=0; i<tones.length; i++) {
        if (tones[i].score > maxScore){
          maxScore = tones[i].score;
          emotion = tones[i].tone_id;
        }
      }
      resolve({emotion, maxScore});
    })
  })
};

/******************************************************************************
* Recognize Character
*******************************************************************************/
const recognizeCharacter = (imageFile) => {
  return new Promise((resolve) => {
    const params = {
      images_file: fs.createReadStream(imageFile),
      classifier_ids: [config.classifierId],
      threshold: 0
    }; 

    visualRecognition.classify(params, (err, res) => {
      if (err) {
        console.log(err);
      } else {
        let classes = res.images[0].classifiers[0].classes
        let maxScore = classes[0].score
        let recognizedClass = classes[0].class
        for (let i=1; i<classes.length; i++) {
          if (classes[i].score > maxScore) {
            maxScore = classes[i].score;
            recognizedClass = classes[i].class;
          }
        }

        console.log("Hello, " + recognizedClass);
        resolve(recognizedClass);
      }
    })
  })
};

/******************************************************************************
* Text To Speech
*******************************************************************************/
const speakResponse = (text) => {
  const params = {
    text: text,
    voice: config.voice,
    accept: 'audio/wav'
  };
  textToSpeech.synthesize(params)
  .pipe(fs.createWriteStream('output.wav'))
  .on('close', () => {
    probe('output.wav', (err, probeData) => {
      pauseDuration = probeData.format.duration;
      micInstance.pause();
      exec('aplay output.wav', (error, stdout, stderr) => {
        if (error !== null) {
          console.log('exec error: ' + error);
        }
      });
    });
  });
}

/******************************************************************************
* Conversation
******************************************************************************/
speakResponse("Hi there, I am awake.");
camera.start();

textStream.on("data", (userSpeechText) => {
  userSpeechText = userSpeechText.toLowerCase();
  console.log("Watson hears: ", userSpeechText);

  if (userSpeechText.indexOf(attentionWord.toLowerCase()) >= 0) {
    startDialog = true;
  }

  if (startDialog) {
    getEmotion(userSpeechText).then((detectedEmotion) => {
      context.emotion = detectedEmotion.emotion;
      context.character = monster;
      conversation.message({
        workspace_id: config.ConWorkspace,
        input: {"text": userSpeechText},
        context: context
      }, (err, response) => {
        context = response.context;
        watsonResponse =  response.output.text[0];
        speakResponse(watsonResponse);
        console.log("Watson says:", watsonResponse);
        if (context.system.dialog_turn_counter == 2) {
          context = {};
          startDialog = false;
        }
      });
    });  
  } else {
    console.log('Waiting to hear the word "', attentionWord, '"');
  }
});