var firebase = require("firebase-admin");

var serviceAccount = require("./zentale-77eac512b7e4.json");

firebase.initializeApp({
    credential: firebase.credential.cert(serviceAccount),
    storageBucket: 'zentale.appspot.com'
});

module.exports = firebase
