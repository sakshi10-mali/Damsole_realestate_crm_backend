const mongoose = require('mongoose');

const footerSchema = new mongoose.Schema({
  logo: {
    type: String,
    trim: true
  },
  companyName: {
    type: String,
    trim: true
  },
  companyTagline: {
    type: String,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  phone: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  address: {
    type: String,
    trim: true
  },
  socialMedia: {
    facebook: String,
    twitter: String,
    instagram: String,
    linkedin: String,
    youtube: String
  },
  quickLinks: [{
    title: String,
    url: String
  }],
  saleLinks: [{
    title: String,
    url: String
  }],
  rentLinks: [{
    title: String,
    url: String
  }],
  bottomLinks: {
    terms: String,
    privacy: String,
    support: String
  },
  copyright: {
    type: String,
    trim: true
  },
  additionalContent: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Footer', footerSchema);

