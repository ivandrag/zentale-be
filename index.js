var express = require('express');
const cors = require('cors');
const axios = require('axios');
const bodyParser = require('body-parser');
var firebase = require("./firebase/index");
var firestore = firebase.firestore()
const { OpenAI } = require('openai');
const { getAudioStoryUrl } = require('./helpers/generate_audio_story_url');
const authMiddleware = require("./middleware/auth-middleware");
const audioAuthMiddleware = require("./middleware/audio-auth-middleware");
const { v4: uuidv4 } = require('uuid');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const bucket = firebase.storage().bucket();

var app = express();
var port = process.env.PORT || 4000;
var server = app.listen(5001);
server.keepAliveTimeout = 30 * 1000;
server.headersTimeout = 35 * 1000;

app.use(cors());

app.use(bodyParser.urlencoded({ limit: '5mb', extended: true }));

app.use(bodyParser.json({ limit: '5mb' }));
app.use('/generate-story', authMiddleware)
app.use('/generate-audio-story', audioAuthMiddleware)

app.post('/generate-story', async (req, res) => {
    const userId = req.userId
    const subscription = req.subscription
    const languageOfTheStory = req.body.languageOfTheStory
    const imageUrlList = req.body.imageUrlList;
    const subscriptionStatus = req.subscriptionStatus
    const maxTokens = subscriptionStatus === "expired" ? 1000 : 4096;
    const visionPromptText = `Create a story title in ${languageOfTheStory} language for the object in the photo.`
    const storyId = uuidv4();

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
        const downloadedImageResponse = await axios({ url: image_url, responseType: 'stream' });

        const filename = `textStories/${userId}/${storyId}.png`;
        const file = bucket.file(filename);

        const stream = file.createWriteStream({
            metadata: {
                contentType: 'image/png',
            },
        });

        await new Promise((resolve, reject) => {
            downloadedImageResponse.data
                .pipe(stream)
                .on('error', reject)
                .on('finish', resolve);
        });

        const [publicUrl] = await file.getSignedUrl({
            action: 'read',
            expires: '03-09-2500',
        });

        const completion = await openai.chat.completions.create({
            messages: [
              {
                role: "system",
                content: "You are an amazing writer, with the Nobel Prize in Literature, the Pulitzer Prize, the Booker Prize, the International Booker Prize, PEN America Literary Awards, and the National Book Award, designed to create amazing stories for kids and adults.",
              },
              { role: "user", content: `Create a story for kids with the following title: ${storyTitle}. Write the story in ${languageOfTheStory}. Do not add the story title when you return the content.` },
            ],
            model: "gpt-4-0125-preview",
          });

        const storyContent = completion.choices[0].message.content

        if (subscription.status === "expired") {
            try {
                await firestore.runTransaction(async (transaction) => {
                    const userRef = firestore.collection('users').doc(userId);
                    const userDoc = await transaction.get(userRef);
                    const userData = userDoc.data();
        
                    if (!userData) {
                        throw new Error('UserDataNotFound');
                    }
        
                    const userSubscription = userData.subscription;
                    if (userSubscription.status === "expired" && userSubscription.textCredits > 0) {
                        const updatedCredits = userSubscription.textCredits - 1;
                        transaction.update(userRef, { 'subscription.textCredits': updatedCredits });
                    }
                });
            } catch (transactionError) {
                console.error("Transaction failed: ", transactionError);
            }
        }

        const storyData = {
            storyId: storyId,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            storyImage: publicUrl,
            storyTitle: sanitizedStoryTitle,
            storyContent: storyContent,
            storyLanguage: languageOfTheStory,
            storyAudioUrl: ""
        };

        await firestore.collection('stories').doc(userId).collection("private").doc(storyId).set(storyData);

        res.send({ "data": storyData });

    } catch(error) {
        console.error("Error in operation: ", error);
        res.status(500).send({"message": "There was an error processing your request"});
    }
})

app.post('/generate-audio-story', async (req, res) => {
    const userId = req.userId;
    const storyId = req.body.storyId;
    
    try {
        const storyRef = firestore.collection('stories').doc(userId).collection("private").doc(storyId);
        const storyDoc = await storyRef.get();

        if (!storyDoc.exists) {
            return res.status(404).send({"message": "Story not found"});
        }

        let storyData = storyDoc.data();
        const { storyContent: text, storyLanguage: language } = storyData;

        const voiceIds = {
            "English": "SoB87aL6OF4PNV53glOc",
            "French": "EjtTWI2Y9BBilPwnIBhg",
            "German": "QtXsTvuI72CiSlfxczvg",
            "Italian": "ByVILX2H5wPAwDiNVKAR", // Germano Carella
            "Spanish": "8ftlfIEYnEkYY6iLanUO",
            "Romanian": "3z9q8Y7plHbvhDZehEII",
            "Russian": "Dvfxihpdb69LFIkmih0k",
            "Portuguese": "NndrHq4eUijN4wsQVtzW",
            "Turkish": "NsFK0aDGLbVusA7tQfOB"
        };

        const voiceId = voiceIds[language];

        if (!voiceId) {
            return res.status(400).send({"message": "Invalid language specified"});
        }

        const audioUrl = await getAudioStoryUrl(text, voiceId, userId);

        storyData.storyAudioUrl = audioUrl;

        await storyRef.update({storyAudioUrl: audioUrl});

        const userRef = firestore.collection('users').doc(userId);
        await firestore.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error('UserDataNotFound');
            }

            const userData = userDoc.data();
            const userSubscription = userData.subscription;
            if (userSubscription && userSubscription.audioCredits > 0) {
                const updatedCredits = userSubscription.audioCredits - 1;
                transaction.update(userRef, { 'subscription.audioCredits': updatedCredits });
            } else {
                throw new Error('InsufficientAudioCredits');
            }
        });

        res.send({"data": storyData});
        
    } catch (error) {
        console.error("Error: ", error);
        if (error.message === 'InsufficientAudioCredits') {
            res.status(403).send({"message": "Insufficient audio credits"});
        } else {
            res.status(500).send({"message": "There was an error processing your request"});
        }
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
    if (status == "active") {
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

app.post('/purchase-created', async (req, res) => {
    const userUid = req.body.event.app_user_id
    const productId = req.body.event.product_id
    let additionalAudioCredits = 0;
    switch (productId) {
        case "stories.starter.pack":
            additionalAudioCredits = 5
            break;
        case "stories.storyteller.pack":
            additionalAudioCredits = 10
            break;
        case "stories.saga.pack":
            additionalAudioCredits = 24
            break;
        default:
            additionalAudioCredits = 0
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
                audioCredits: currentAudioCredits + additionalAudioCredits
            }
        }, { merge: true });

        res.sendStatus(200);
    } catch (error) {
        console.error("Error updating user subscription status:", error);
        res.sendStatus(500);
    }
})

app.listen(port, () => {
    console.log('Server started on: ' + port);
});