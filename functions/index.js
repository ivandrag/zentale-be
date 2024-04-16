const crypto = require('crypto');
const functions = require("firebase-functions");
const firebase = require("firebase-admin");
firebase.initializeApp()
var firestore = firebase.firestore()

exports.resetCreditsForFreeUsers = functions.pubsub
    .schedule('0 0 1 * *')
    .onRun(async (context) => {
        const users = firestore.collection('users');
        
        const freeUsersSnapshot = await users
            .where('subscription.status', '==', 'expired')
            .get();
        
        const batch = firestore.batch();
        
        freeUsersSnapshot.forEach(doc => {
            const userRef = doc.ref;
            batch.update(userRef, { 'subscription.textCredits': 2 });
        });
        
        await batch.commit();
    
        return null;
    });


exports.assignCreditsToNewUsers = functions.auth.user().onCreate(async (user) => {
    const apiKey = crypto.randomBytes(20).toString('hex');

    const data = {
        email: user.email,
        apiKey: apiKey,
        displayName: user.displayName,
        photoUrl: user.photoURL,
        created: firebase.firestore.FieldValue.serverTimestamp(),
        subscription: { 
            status: "expired", 
            type: "", 
            textCredits: 2, 
            audioCredits: 0 
        }
    };

    const users = firestore.collection('users')
    await users.doc(user.uid).set(data)
});

exports.assignAudioCreditsToYearlyUsers = functions.pubsub
    .schedule('0 0 1 * *')
    .onRun(async (context) => {
        const users = firestore.collection('users');
        
        const yearlyActiveUsersSnapshot = await users
            .where('subscription.type', '==', 'stories-yearly')
            .where('subscription.status', '==', 'active')
            .get();
        
        const batch = firestore.batch();

        yearlyActiveUsersSnapshot.forEach(doc => {
            const userRef = doc.ref;
            batch.update(userRef, { 
                'subscription.audioCredits': firebase.firestore.FieldValue.increment(10),
                'subscription.textCredits': firebase.firestore.FieldValue.increment(10)
                });
            });
            
         await batch.commit();
    
        return null;
    });

// exports.cleanupUserData = functions.auth.user().onDelete(async (user) => {
//     const userId = user.uid;

//     const userRef = firestore.collection('users').doc(userId);
//     await userRef.delete();

//     const freeChatsRef = firestore.collection('free-chats').doc(userId);
//     await freeChatsRef.delete();

//     const premiumChatsRef = firestore.collection('premium-chats').doc(userId);
//     await premiumChatsRef.delete();

//     const predictionsRef = firestore.collection('predictions');
//     const predictionsSnapshot = await predictionsRef.where('userId', '==', userId).get();

//     const batch = firestore.batch();
//     predictionsSnapshot.forEach((doc) => {
//         batch.delete(doc.ref);
//     });
//     await batch.commit();

//     const bucket = firebase.storage().bucket("carphoto-2a9a6.appspot.com")
//     const paidPrefix = `paid/${userId}/predictions/`;
//     const paidFiles = await bucket.getFiles({ prefix: paidPrefix });
//     const paidDeletes = paidFiles[0].map(file => file.delete().catch(error => {
//         console.error(`Failed to delete ${file.name}:`, error);
//     }));

//     const freePrefix = `free/${userId}/predictions/`;
//     const freeFiles = await bucket.getFiles({ prefix: freePrefix });
//     const freeDeletes = freeFiles[0].map(file => file.delete().catch(error => {
//         console.error(`Failed to delete ${file.name}:`, error);
//     }));

//     await Promise.all([...paidDeletes, ...freeDeletes]);
// });