const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Banner title is required'],
    trim: true
  },
  subtitle: String,
  description: String,
  image: {
    type: String,
    required: [true, 'Banner image is required']
  },
  link: String,
  linkText: String,
  position: {
    type: String,
    enum: ['homepage', 'about', 'services', 'contact', 'all'],
    default: 'homepage'
  },
  order: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  startDate: Date,
  endDate: Date
}, {
  timestamps: true
});

module.exports = mongoose.model('Banner', bannerSchema);

