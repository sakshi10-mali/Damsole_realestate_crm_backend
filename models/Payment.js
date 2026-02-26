const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  transaction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    required: true
  },
  lead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lead',
    required: true
  },
  property: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property',
    required: true
  },
  agency: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agency',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    default: 'USD'
  },
  paymentMethod: {
    type: String,
    enum: ['razorpay', 'stripe', 'cash', 'cheque', 'bank_transfer', 'other'],
    required: true
  },
  gateway: {
    type: String,
    enum: ['razorpay', 'stripe', 'none'],
    default: 'none'
  },
  gatewayPaymentId: {
    type: String,
    sparse: true
  },
  gatewayOrderId: {
    type: String,
    sparse: true
  },
  gatewaySignature: {
    type: String,
    sparse: true
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'refunded', 'cancelled'],
    default: 'pending'
  },
  paymentDate: {
    type: Date,
    default: Date.now
  },
  receipt: {
    url: String,
    number: String
  },
  refund: {
    amount: Number,
    reason: String,
    refundedAt: Date,
    gatewayRefundId: String
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Indexes
paymentSchema.index({ transaction: 1 });
paymentSchema.index({ lead: 1 });
paymentSchema.index({ property: 1 });
paymentSchema.index({ agency: 1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ paymentDate: -1 });

module.exports = mongoose.model('Payment', paymentSchema);

