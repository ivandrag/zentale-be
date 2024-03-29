const axios = require('axios');
var firebase = require("../firebase/index");
const elevenLabsKey = process.env.ELEVENLABS_KEY

async function getAudioStoryUrl(text, voiceId, userId) {
  try {
    const response = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      data: {
        text: text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
            similarity_boost: 0.5,
            stability: 0.5
        }
      },
      headers: {
        'xi-api-key': elevenLabsKey,
        'Content-Type': 'application/json'
      },
      responseType: 'stream'
    });

    const fileName = `audioStories/${userId}/${Date.now()}-${voiceId}.mp3`;
    const file = firebase.storage().bucket().file(fileName);

    await new Promise((resolve, reject) => {
      response.data.pipe(file.createWriteStream({
        metadata: {
          contentType: 'audio/mpeg',
        }
      }))
      .on('error', (error) => reject(error))
      .on('finish', () => resolve());
    });

    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-09-2500',
    });

    return url;

  } catch (error) {
    console.error('Error generating audio story: ', error);
    throw new Error('Failed to generate audio story.');
  }
}

module.exports = { getAudioStoryUrl };
