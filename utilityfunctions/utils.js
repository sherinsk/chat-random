function findKeyByValue(obj, value) {
    for (const [key, val] of Object.entries(obj)) {
        if (val === value) {
            return key;
        }
    }
    return undefined; // Return undefined if the value is not found
}

module.exports = findKeyByValue;
