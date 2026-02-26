const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['lead_created', 'lead_updated', 'lead_assigned', 'lead_status_changed', 
            'property_created', 'property_updated', 'property_approved', 'property_rejected',
            'user_created', 'user_updated', 'user_deleted',
            'transaction_created', 'transaction_updated',
            'note_added', 'communication_logged', 'task_created', 'task_completed',
            'other'],
    required: true
  },
  entityType: {
    type: String,
    enum: ['lead', 'property', 'user', 'transaction', 'agency', 'other'],
    required: true
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  title: {
    type: String,
    required: true
  },
  description: String,
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },
  agency: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agency'
  },
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  relatedUsers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }]
}, {
  timestamps: true
});

// Indexes for efficient queries
activitySchema.index({ entityType: 1, entityId: 1 });
activitySchema.index({ agency: 1, createdAt: -1 });
activitySchema.index({ performedBy: 1, createdAt: -1 });
activitySchema.index({ type: 1, createdAt: -1 });
activitySchema.index({ createdAt: -1 });

module.exports = mongoose.model('Activity', activitySchema);

