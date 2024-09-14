// utils.js
function findKeyByValue(map, value) {
    for (const [key, val] of map.entries()) {
        if (val === value) {
            return key;
        }
    }
    return undefined; // Return undefined if the value is not found
}

module.exports = findKeyByValue;
