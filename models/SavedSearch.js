const mongoose = require('mongoose');

const savedSearchSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  searchCriteria: {
    propertyType: [String],
    listingType: String,
    city: String,
    state: String,
    country: String,
    minPrice: Number,
    maxPrice: Number,
    bedrooms: Number,
    bathrooms: Number,
    minArea: Number,
    maxArea: Number,
    amenities: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Amenity'
    }],
    keywords: String
  },
  emailAlerts: {
    type: Boolean,
    default: false
  },
  alertFrequency: {
    type: String,
    enum: ['daily', 'weekly', 'immediate'],
    default: 'daily'
  },
  lastAlertSent: Date,
  isActive: {
    type: Boolean,
    default: true
  },
  matchCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Indexes
savedSearchSchema.index({ user: 1 });
savedSearchSchema.index({ isActive: 1 });
savedSearchSchema.index({ emailAlerts: 1, alertFrequency: 1 });

module.exports = mongoose.model('SavedSearch', savedSearchSchema);

