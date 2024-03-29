var firebase = require("../firebase/index");
var firestore = firebase.firestore()

function audioAuthMiddleware(request, response, next) {
    const headerToken = request.headers.authorization;
    console.log(headerToken)
    if (!headerToken) {
        return response.status(401).send({ message: "No token provided" });
    }

    if (headerToken && headerToken.split(" ")[0] !== "Bearer") {
        response.status(401).send({ message: "Invalid token" });
    }

    const token = headerToken.split(" ")[1];
    firebase
        .auth()
        .verifyIdToken(token)
        .then((decodedToken) => {
            request.userId = decodedToken.user_id;
            firestore.collection('users')
                .doc(decodedToken.user_id)
                .get()
                .then(snapshot => {
                    var data = snapshot.data()
                    let subscription = data.subscription
                    request.subscription = subscription
                    if (subscription.audioCredits <= 0) {
                        response.status(403).send({ message: "You need at least one credit to generate an audio story" })
                    } else {
                        next()
                    }
                }).catch(() => response.status(404).send({ message: "Could not authorize" }));
        })
        .catch(() => response.status(403).send({ message: "Could not authorize" }));
}

module.exports = audioAuthMiddleware;