require('dotenv').config();
require('colors');

const express = require('express');
const ExpressWs = require('express-ws');
const { GptService } = require('./services/gpt-service');
const { StreamService } = require('./services/stream-service');
const { TranscriptionService } = require('./services/transcription-service');
const { TextToSpeechService } = require('./services/tts-service');
const { recordingService } = require('./services/recording-service');
const VoiceResponse = require('twilio').twiml.VoiceResponse;

const app = express();
ExpressWs(app);

// parse application/x-www-form-urlencoded so req.body is populated
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

app.post('/incoming', (req, res) => {
  try {
    const twiml = new VoiceResponse();
    // connect and stream BOTH directions
    twiml.connect().stream({
      url: `wss://${process.env.SERVER}/connection`,
      track: 'both_tracks'
    });

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('❌ /incoming error', err);
    res.sendStatus(500);
  }
});

app.ws('/connection', (ws) => {
  try {
    ws.on('error', console.error);

    let streamSid, callSid;
    const gptService = new GptService();
    const streamService = new StreamService(ws);
    const transcriptionService = new TranscriptionService();
    const ttsService = new TextToSpeechService({});
    let marks = [], interactionCount = 0;

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        callSid   = msg.start.callSid;

        streamService.setStreamSid(streamSid);
        gptService.setCallSid(callSid);

        // optionally record
        recordingService(ttsService, callSid).then(() => {
          console.log(`📡 Media Stream started: ${streamSid}`.underline.red);
          ttsService.generate({
            partialResponseIndex: 0,
            partialResponse:      "Hello! I understand you're looking for a pair of AirPods, is that correct?"
          }, 0);
        });

      } else if (msg.event === 'media') {
        transcriptionService.send(msg.media.payload);

      } else if (msg.event === 'mark') {
        console.log(`🔖 mark: ${msg.mark.name}`);
        marks = marks.filter(m => m !== msg.mark.name);

      } else if (msg.event === 'stop') {
        console.log(`🛑 Stream stopped: ${streamSid}`);
      }
    });

    transcriptionService.on('utterance', (text) => {
      if (marks.length && text?.length > 5) {
        console.log('🔄 clearing stream for interruption');
        ws.send(JSON.stringify({ streamSid, event: 'clear' }));
      }
    });

    transcriptionService.on('transcription', (text) => {
      if (!text) return;
      console.log(`🗣 STT → GPT: ${text}`);
      gptService.completion(text, interactionCount);
      interactionCount++;
    });

    gptService.on('gptreply', (gptReply, idx) => {
      console.log(`🤖 GPT → TTS: ${gptReply.partialResponse}`);
      ttsService.generate(gptReply, idx);
    });

    ttsService.on('speech', (idx, audio, label) => {
      console.log(`🔊 TTS → Twilio [${label}]`);
      streamService.buffer(idx, audio);
    });

    streamService.on('audiosent', (markLabel) => {
      marks.push(markLabel);
    });

  } catch (err) {
    console.error('❌ /connection error', err);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});
