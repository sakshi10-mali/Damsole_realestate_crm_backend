const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  plan_name: { type: String, required: true, trim: true },
  name: { type: String, trim: true }, // Keep as fallback
  description: { type: String, default: '' },
  price: { type: Number, default: 0 },
  billing_cycle: { type: String, default: 'monthly' },
  interval: { type: String, enum: ['monthly', 'yearly', 'one_time'], default: 'monthly' },
  features: [{ type: String }],
  is_active: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  validity_days: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

planSchema.index({ isActive: 1 });

module.exports = mongoose.model('Plan', planSchema);

