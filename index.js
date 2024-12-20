var express = require('express');
const cors = require('cors');
const axios = require('axios');
const bodyParser = require('body-parser');
var firebase = require("./firebase/index");
var firestore = firebase.firestore()
const { OpenAI } = require('openai');
const mime = require('mime-types');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const tmp = require('tmp');

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
app.use('/create-story', authMiddleware)

app.post('/create-story', async (req, res) => {
    try {
      const userId = req.userId
      const subscription = req.subscription
      const { imageUrl, languageOfTheStory, storyId } = req.body;
      if (!imageUrl || !languageOfTheStory || !storyId) {
        return res.status(400).json({ error: 'No image URL or language or storyId provided' });
      }
  
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data, 'binary');
    const mimeType = response.headers['content-type'];

    // Create a temporary file
    const tmpFile = tmp.fileSync({ postfix: `.${mime.extension(mimeType)}` });
    fs.writeFileSync(tmpFile.name, buffer);

      const apiKey = process.env.GEMINI_API_KEY
      const fileManager = new GoogleAIFileManager(apiKey);
      const uploadResult = await fileManager.uploadFile(tmpFile.name, {
        mimeType: mimeType,
        displayName: `Uploaded image from URL`,
      });
  
      const fileUri = uploadResult.file.uri;
    
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const visionPromptText = `Identify the object in this photo. Imagine this object as a character in a children's fairy tale. Generate a playful and magical story title in ${languageOfTheStory} that could be used for a storybook. Return only the story title.`
  
      const result = await model.generateContent([
        visionPromptText,
        {
          fileData: {
            fileUri: fileUri,
            mimeType: mimeType,
          },
        },
      ]);
  
      tmpFile.removeCallback();

      const storyTitle = result.response.text();
      let sanitizedStoryTitle = storyTitle.replace(/"/g, '');

      const storyPrompt = `Create a story for kids with the following title: ${sanitizedStoryTitle}. Use an easy to understand language for children between 2 to 7 years old. Do not write complicated phrases or words. Maximum text length should be 1500 characters. The story should teach a learning. Write the story in ${languageOfTheStory}. Do not add the story title when you return the content.`;

      const storyResult = await model.generateContent([storyPrompt]);

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

    const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp()

    const storyData = {
        storyId: storyId,
        createdAt: serverTimestamp,
        storyImage: imageUrl,
        storyTitle: sanitizedStoryTitle,
        storyContent: storyResult.response.text(),
        storyLanguage: languageOfTheStory,
        storyAudioUrl: "",
        status: "success"
    };

    await firestore.collection('stories').doc(userId).collection("private").doc(storyId).set(storyData);

    res.send({ "data": "success" });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

app.post('/generate-story', async (req, res) => {
    const userId = req.userId
    const subscription = req.subscription
    const languageOfTheStory = req.body.languageOfTheStory
    const imageUrlList = req.body.imageUrlList;
    const subscriptionStatus = req.subscriptionStatus
    const maxTokens = subscriptionStatus === "expired" ? 1000 : 4096;
    // const visionPromptText = `Create a story title in ${languageOfTheStory} language for the object in the photo.`
    const visionPromptText = `Identify the object in this photo. Imagine this object as a character in a children's fairy tale. Generate a playful and magical story title in ${languageOfTheStory} that could be used for a storybook. Return only the story title.`
    // const storyId = uuidv4();
    const storyId = req.body.storyId

    const imageUrlObjects = imageUrlList.map(url => ({
        type: "image_url",
        image_url: {
            "url": url
        }
    }));  

    try {
        const visionResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: maxTokens,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: visionPromptText },
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
              { role: "user", content: `Create a story for kids with the following title: ${storyTitle}. Use an easy to understand language for children between 2 to 7 years old. Do no write complicated phrases or words. Maximum text length should be 1500 characters. The story should teach a learning. Write the story in ${languageOfTheStory}. Do not add the story title when you return the content.` },
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

        const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp()

        const storyData = {
            storyId: storyId,
            createdAt: serverTimestamp,
            storyImage: publicUrl,
            storyTitle: sanitizedStoryTitle,
            storyContent: storyContent,
            storyLanguage: languageOfTheStory,
            storyAudioUrl: "",
            status: "success"
        };

        await firestore.collection('stories').doc(userId).collection("private").doc(storyId).set(storyData);

        res.send({ "data": storyData });

    } catch(error) {
        console.error("Error in operation: ", error);
        const storyData = {
            storyId: storyId,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            storyImage: "",
            storyTitle: "",
            storyContent: "",
            storyLanguage: "",
            storyAudioUrl: "",
            status: "error"
        };

        await firestore.collection('stories').doc(userId).collection("private").doc(storyId).set(storyData);
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
            "English": "wJqPPQ618aTW29mptyoc",  // <- Ana Rita : Ella -> "SoB87aL6OF4PNV53glOc",
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
            case "stories.monthly":
                type = "stories-monthly";
                additionalAudioCredits = 10;
                break;
            case "stories.yearly":
                type = "stories-yearly";
                additionalAudioCredits = 10;
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
    let additionalTextCredits = 0;
    switch (productId) {
        case "stories.starter.pack":
            additionalAudioCredits = 5
            additionalTextCredits = 5
            break;
        case "stories.storyteller.pack":
            additionalAudioCredits = 10
            additionalTextCredits = 10
            break;
        case "stories.saga.pack":
            additionalAudioCredits = 24
            additionalTextCredits = 24
            break;
        default:
            additionalAudioCredits = 0
            additionalTextCredits = 0
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
        const currentTextCredits = userData.subscription && userData.subscription.textCredits ? userData.subscription.textCredits : 0;

        await userRef.set({
            subscription: {
                audioCredits: currentAudioCredits + additionalAudioCredits,
                textCredits: currentTextCredits + additionalTextCredits
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