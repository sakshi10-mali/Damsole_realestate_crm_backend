const mongoose = require('mongoose');

const scriptSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Script name is required'],
        trim: true
    },
    description: String,
    code: {
        type: String,
        required: [true, 'Script code is required']
    },
    placement: {
        type: String,
        enum: ['head', 'body_start', 'body_end'],
        default: 'head'
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Script', scriptSchema);
