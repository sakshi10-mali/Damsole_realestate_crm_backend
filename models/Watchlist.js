const mongoose = require('mongoose');

const watchlistSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  property: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property',
    required: true
  },
  notes: String,
  notified: {
    type: Boolean,
    default: false
  },
  notifiedAt: Date
}, {
  timestamps: true
});

// Ensure one property per user (unique constraint)
watchlistSchema.index({ user: 1, property: 1 }, { unique: true });

// Indexes for efficient queries
watchlistSchema.index({ user: 1, createdAt: -1 });
watchlistSchema.index({ property: 1 });

module.exports = mongoose.model('Watchlist', watchlistSchema);

