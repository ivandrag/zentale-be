var firebase = require("../firebase/index");

function revenueCatWebHookMiddleware(request, response, next) {
    const headerToken = request.headers.authorization;

    if (!headerToken) {
        return response.status(401).send({ message: "No token provided" });
    }

    if (headerToken && headerToken.split(" ")[0] !== "Bearer") {
        response.status(401).send({ message: "Invalid token" });
    }

    const token = headerToken.split(" ")[1];
    revenueCatBearer = process.env.REVENUE_CAT_WEB_HOOK_BEARER

    if (token === revenueCatBearer) {
        next()
    } else {
        response.status(403).send({ message: "Could not authorize" })
    }
}

module.exports = revenueCatWebHookMiddleware;