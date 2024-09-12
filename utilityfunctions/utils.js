function findKeyByValue(object, value) {
    // Iterate over the keys of the object
    for (const key in object) {
        if (object[key] === value) {
            return key;
        }
    }
    return undefined; // Return undefined if the value is not found
}

module.exports = findKeyByValue;