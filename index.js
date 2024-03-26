var express = require('express');
const cors = require('cors');
const axios = require('axios');
const bodyParser = require('body-parser');
var firebase = require("./firebase/index");
var firestore = firebase.firestore()
const { OpenAI } = require('openai');
const authMiddleware = require("./middleware/auth-middleware");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const elevenLabsKey = process.env.ELEVENLABS_KEY

const bucket = firebase.storage().bucket();

var app = express();
var port = process.env.PORT || 4000;
var server = app.listen(5001);
server.keepAliveTimeout = 30 * 1000;
server.headersTimeout = 35 * 1000;

app.use(cors());

app.use(bodyParser.urlencoded({ limit: '5mb', extended: true }));

app.use(bodyParser.json({ limit: '5mb' }));
// app.use('/generate-story', authMiddleware)

app.post('/generate-story', async (req, res) => {
    const userId = req.userId
    const languageOfTheStory = req.body.languageOfTheStory
    const imageUrlList = req.body.imageUrlList;
    const subscriptionStatus = req.subscriptionStatus
    const maxTokens = subscriptionStatus === "expired" ? 1000 : 4096;
    const visionPromptText = `Create a story title in ${languageOfTheStory} language for the object in the photo.`

    const imageUrlObjects = imageUrlList.map(url => ({
        type: "image_url",
        image_url: url
    }));

    try {
        const visionResponse = await openai.chat.completions.create({
            model: "gpt-4-vision-preview",
            max_tokens: maxTokens,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", 
                        text: visionPromptText 
                    },
                        ...imageUrlObjects
                    ],
                },
            ],
        });

        const storyTitle = visionResponse.choices[0].message.content

        let sanitizedStoryTitle = storyTitle.replace(/"/g, '');

        const imageResponse = await openai.images.generate({
            model: "dall-e-3",
            prompt: `Create a simple image for a story called: ${sanitizedStoryTitle} without any text or letters in the image.`,
            n: 1,
            size: "1024x1024",
          });

        image_url = imageResponse.data[0].url;

        const completion = await openai.chat.completions.create({
            messages: [
              {
                role: "system",
                content: "You are an amazing writer, with the Nobel Prize in Literature, the Pulitzer Prize, the Booker Prize, the International Booker Prize, PEN America Literary Awards, and the National Book Award, designed to create amazing stories for kids and adults.",
              },
              { role: "user", content: `Create a story for kids with the following title: ${storyTitle}. Write the story in ${languageOfTheStory}. Do not add the story title when you return the content.` },
            ],
            model: "gpt-4-0125-preview",
            // response_format: { type: "json_object" },
          });

        const storyContent = completion.choices[0].message.content

        res.send({"data": {
            "storyId": "",
            "storyImage": image_url, 
            "storyTitle": sanitizedStoryTitle, 
            "storyContent": storyContent,
            "storyLanguage": languageOfTheStory
        }})

    } catch(error) {
        console.error("Error in operation: ", error);
        res.status(500).send({"message": "There was an error processing your request"});
    }
})

app.post('/generate-audio-story', async (req, res) => {
    // const userId = req.userId
    const userId = "random"
    // const voiceId = req.body.voiceId
    const language = req.body.language
    const text = req.body.text
    const englishVoiceId = "SoB87aL6OF4PNV53glOc"; // Using Ella Soft and sweet for this example
    const romanianVoiceId = "3z9q8Y7plHbvhDZehEII"
    const spanishVoiceId = "8ftlfIEYnEkYY6iLanUO"

    let voiceId
    switch (language) {
        case "English":
            voiceId = englishVoiceId
            break;
        case "Spanish":
            voiceId = spanishVoiceId
            break;
        case "Romanian":
            voiceId = romanianVoiceId
            break;
        default:
            break;
    } 

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
        const file = bucket.file(fileName);

        response.data.pipe(file.createWriteStream({
            metadata: {
                contentType: 'audio/mpeg',
            }
        }))
        .on('error', (error) => {
            console.error('Error streaming file to Firebase Storage:', error);
            res.status(500).send('Failed to upload audio story');
        })
        .on('finish', () => {
            file.getSignedUrl({
                action: 'read',
                expires: '03-09-2500', 
            }).then(signedUrls => {
                const url = signedUrls[0];
                res.send({"data": {"storyId": "", "storyAudioUrl": url}})
            }).catch(error => {
                console.error('Error generating signed URL:', error);
            });
        });
        
    } catch (error) {
        console.error("Error generating audio story: ", error);
        res.status(500).send({"message": "There was an error processing your request"});
    }
});

app.post('/update-subscription', async (req, res) => {
    const userUid = req.body.event.app_user_id;
    const productId = req.body.event.product_id;
    const eventType = req.body.event.type;

    let status = "";
    if (eventType === "INITIAL_PURCHASE" || eventType === "RENEWAL") {
        status = "active";
    } else if (eventType === "EXPIRATION") {
        status = "expired";
    }

    let type = "";
    let additionalAudioCredits = 0;
    switch (productId) {
        case "zentale.lite.weekly":
            type = "lite-weekly";
            additionalAudioCredits = 2;
            break;
        case "zentale.lite.monthly":
            type = "lite-monthly";
            additionalAudioCredits = 10;
            break;
        case "zentale.lite.yearly":
            type = "lite-yearly";
            additionalAudioCredits = 130;
            break;
        default:
            type = "unknown";
    }

    try {
        const userRef = firestore.collection('users').doc(userUid);
        const doc = await userRef.get();
        if (!doc.exists) {
            console.error("User not found");
            return res.sendStatus(404);
        }
        const userData = doc.data();
        const currentAudioCredits = userData.subscription && userData.subscription.audioCredits ? userData.subscription.audioCredits : 0;

        await userRef.set({
            subscription: {
                status: status,
                type: type,
                audioCredits: currentAudioCredits + additionalAudioCredits
            }
        }, { merge: true });

        res.sendStatus(200);
    } catch (error) {
        console.error("Error updating user subscription status:", error);
        res.sendStatus(500);
    }
});

app.listen(port, () => {
    console.log('Server started on: ' + port);
});