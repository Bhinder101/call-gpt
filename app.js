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

const PORT = process.env.PORT || 3000;

app.post('/incoming', (req, res) => {
  try {
    const response = new VoiceResponse();
    response
      .connect()
      .stream({ url: `wss://${process.env.SERVER}/connection`, track: 'both_tracks' });
    // add a pause so the greeting TTS can play fully before Twilio
    response.pause({ length: 1 });

    res.type('text/xml').send(response.toString());
    console.log('📞 /incoming served TwiML');
  } catch (err) {
    console.error('❌ /incoming error', err);
    res.sendStatus(500);
  }
});

app.ws('/connection', (ws) => {
  console.log('🟢 WebSocket connected');

  let streamSid;
  let callSid;

  const gptService = new GptService();
  const streamService = new StreamService(ws);
  const transcriptionService = new TranscriptionService();
  const ttsService = new TextToSpeechService({});
  
  // optional: dump every frame type
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.warn('⚠️ WS non-JSON message', data);
      return;
    }
    console.log(`⏺️ WS frame: ${msg.event}`);
    
    switch (msg.event) {
      case 'start':
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        console.log(`🔗 start streamSid=${streamSid} callSid=${callSid}`);
        streamService.setStreamSid(streamSid);
        gptService.setCallSid(callSid);
        recordingService(ttsService, callSid).then(() => {
          console.log(`🔴 Recording started, sending initial greeting`);
          ttsService.generate({
            partialResponseIndex: null,
            partialResponse: "Hello! I understand you're looking for a pair of AirPods, is that correct?"
          }, 0);
        });
        break;

      case 'media':
        transcriptionService.send(msg.media.payload);
        break;

      case 'mark':
        console.log(`🔖 mark: ${msg.mark.name}`);
        break;

      case 'stop':
        console.log(`🛑 stream stopped`);
        break;
    }
  });

  transcriptionService.on('utterance', (text) => {
    if (text && text.length > 5) {
      console.log(`✂️ interruption detected, clearing stream`);
      ws.send(JSON.stringify({ streamSid, event: 'clear' }));
    }
  });

  transcriptionService.on('transcription', (text) => {
    if (!text) return;
    console.log(`🤖 STT -> GPT: "${text}"`);
    gptService.completion(text);
  });

  gptService.on('gptreply', (gptReply) => {
    console.log(`💬 GPT -> TTS: "${gptReply.partialResponse}"`);
    ttsService.generate(gptReply);
  });

  ttsService.on('speech', (responseIndex, audio, label) => {
    console.log(`🎙️ TTS -> Stream (mark="${label}")`);
    streamService.buffer(responseIndex, audio);
  });

  streamService.on('audiosent', (markLabel) => {
    console.log(`✅ audio chunk sent, mark="${markLabel}"`);
  });

  ws.on('error', (err) => {
    console.error('⚠️ WebSocket error', err);
  });

  ws.on('close', () => {
    console.log('❌ WebSocket closed');
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
