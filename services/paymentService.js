const Razorpay = require('razorpay');
const stripe = require('stripe');
const PDFDocument = require('pdfkit');
const Payment = require('../models/Payment');
const Transaction = require('../models/Transaction');
const Lead = require('../models/Lead');

class PaymentService {
  constructor() {
    // Initialize Razorpay
    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
      this.razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      });
    }

    // Initialize Stripe
    if (process.env.STRIPE_SECRET_KEY) {
      this.stripe = stripe(process.env.STRIPE_SECRET_KEY);
    }
  }

  /**
   * Create payment order for Razorpay
   */
  async createRazorpayOrder(amount, currency = 'INR', metadata = {}) {
    if (!this.razorpay) {
      throw new Error('Razorpay not configured');
    }

    try {
      const options = {
        amount: amount * 100, // Convert to paise
        currency: currency,
        receipt: `receipt_${Date.now()}`,
        notes: metadata
      };

      const order = await this.razorpay.orders.create(options);
      return order;
    } catch (error) {
      console.error('Razorpay order creation error:', error);
      throw error;
    }
  }

  /**
   * Verify Razorpay payment signature
   */
  verifyRazorpaySignature(orderId, paymentId, signature) {
    if (!this.razorpay) {
      throw new Error('Razorpay not configured');
    }

    const crypto = require('crypto');
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(orderId + '|' + paymentId)
      .digest('hex');

    return generatedSignature === signature;
  }

  /**
   * Create payment intent for Stripe
   */
  async createStripePaymentIntent(amount, currency = 'usd', metadata = {}) {
    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    try {
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: amount * 100, // Convert to cents
        currency: currency.toLowerCase(),
        metadata: metadata
      });

      return paymentIntent;
    } catch (error) {
      console.error('Stripe payment intent creation error:', error);
      throw error;
    }
  }

  /**
   * Verify Stripe payment
   */
  async verifyStripePayment(paymentIntentId) {
    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    try {
      const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
      return paymentIntent;
    } catch (error) {
      console.error('Stripe payment verification error:', error);
      throw error;
    }
  }

  /**
   * Create payment record
   */
  async createPayment(paymentData) {
    try {
      const payment = new Payment(paymentData);
      await payment.save();
      return payment;
    } catch (error) {
      console.error('Payment creation error:', error);
      throw error;
    }
  }

  /**
   * Update payment status
   */
  async updatePaymentStatus(paymentId, status, gatewayData = {}) {
    try {
      const payment = await Payment.findById(paymentId);
      if (!payment) {
        throw new Error('Payment not found');
      }

      payment.status = status;

      if (gatewayData.paymentId) {
        payment.gatewayPaymentId = gatewayData.paymentId;
      }
      if (gatewayData.orderId) {
        payment.gatewayOrderId = gatewayData.orderId;
      }
      if (gatewayData.signature) {
        payment.gatewaySignature = gatewayData.signature;
      }

      if (status === 'completed') {
        payment.paymentDate = new Date();
        // Generate receipt number
        payment.receipt = {
          number: `RCP-${Date.now()}`,
          url: `/api/payments/${paymentId}/receipt`
        };

        // Update transaction status
        const transaction = await Transaction.findById(payment.transaction);
        if (transaction) {
          transaction.status = 'completed';
          await transaction.save();
        }

        // Update lead booking status
        const lead = await Lead.findById(payment.lead);
        if (lead) {
          if (!lead.booking) {
            lead.booking = {};
          }

          lead.booking.agreementStatus = 'signed';

          if (transaction && (transaction.status === 'completed' || payment.status === 'completed')) {
            // If transaction is completed, the lead status effectively becomes closed/won, but we keep 'booked' or move to 'customer'
            lead.status = 'booked';
            // Also update property if not already set correctly
            if (transaction.property && (!lead.property || lead.property.toString() !== transaction.property.toString())) {
              lead.property = transaction.property;
            }
          }
          await lead.save();
        }

        // Update Property Status to 'sold' or 'rented'
        if (transaction && transaction.property) {
          const Property = require('../models/Property');
          const property = await Property.findById(transaction.property);
          if (property) {
            if (transaction.type === 'sale') {
              property.status = 'sold';
            } else if (transaction.type === 'rent') {
              property.status = 'rented';
            }
            await property.save();
          }
        }

        // Send confirmation email to customer
        try {
          const emailService = require('./emailService');
          const Property = require('../models/Property');
          const property = await Property.findById(payment.property);
          await emailService.sendPaymentSuccessEmail(payment, lead, property);
        } catch (emailError) {
          console.error('Failed to send payment success email:', emailError);
        }
      }

      await payment.save();
      return payment;
    } catch (error) {
      console.error('Payment status update error:', error);
      throw error;
    }
  }

  /**
   * Process refund
   */
  async processRefund(paymentId, amount, reason) {
    try {
      const payment = await Payment.findById(paymentId);
      if (!payment) {
        throw new Error('Payment not found');
      }

      if (payment.status !== 'completed') {
        throw new Error('Only completed payments can be refunded');
      }

      let refundResult = null;

      // Process refund through gateway
      if (payment.gateway === 'razorpay' && payment.gatewayPaymentId) {
        if (!this.razorpay) {
          throw new Error('Razorpay not configured');
        }
        refundResult = await this.razorpay.payments.refund(payment.gatewayPaymentId, {
          amount: amount * 100 // Convert to paise
        });
      } else if (payment.gateway === 'stripe' && payment.gatewayPaymentId) {
        if (!this.stripe) {
          throw new Error('Stripe not configured');
        }
        refundResult = await this.stripe.refunds.create({
          payment_intent: payment.gatewayPaymentId,
          amount: amount * 100 // Convert to cents
        });
      }

      // Update payment record
      payment.status = 'refunded';
      payment.refund = {
        amount: amount,
        reason: reason,
        refundedAt: new Date(),
        gatewayRefundId: refundResult?.id || null
      };

      await payment.save();

      // Update transaction status
      const transaction = await Transaction.findById(payment.transaction);
      if (transaction) {
        transaction.status = 'refunded';
        await transaction.save();
      }

      return payment;
    } catch (error) {
      console.error('Refund processing error:', error);
      throw error;
    }
  }

  /**
   * Generate payment receipt PDF
   */
  async generateReceipt(paymentId) {
    try {
      const payment = await Payment.findById(paymentId)
        .populate('transaction')
        .populate('lead')
        .populate('property')
        .populate('agency');

      if (!payment) {
        throw new Error('Payment not found');
      }

      return {
        paymentId: payment._id,
        receiptNumber: payment.receipt?.number || `RCP-${payment._id}`,
        date: payment.paymentDate,
        amount: payment.amount,
        currency: payment.currency,
        paymentMethod: payment.paymentMethod,
        property: payment.property?.title,
        lead: payment.lead ? `${payment.lead.contact.firstName} ${payment.lead.contact.lastName}` : null,
        agency: payment.agency?.name
      };
    } catch (error) {
      console.error('Receipt generation error:', error);
      throw error;
    }
  }

  /**
   * Generate PDF Receipt - designed to match the Transaction Details modal (invoice layout).
   * @param {string} paymentId
   * @param {{ asBuffer?: boolean }} opts - If asBuffer: true, returns Promise<Buffer> (for email attachment).
   */
  async generateReceiptPDF(paymentId, opts = {}) {
    try {
      const payment = await Payment.findById(paymentId)
        .populate({
          path: 'transaction',
          populate: { path: 'property' }
        })
        .populate('lead')
        .populate('property')
        .populate('agency');

      if (!payment) {
        throw new Error('Payment not found');
      }

      const transaction = payment.transaction;
      const lead = payment.lead;
      const property = payment.property || transaction?.property;
      const agency = payment.agency;

      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const path = require('path');
      const fs = require('fs');
      const pageWidth = doc.page.width - 100;
      const left = 50;
      const GRAY_400 = '#9ca3af';
      const GRAY_700 = '#374151';
      const GRAY_900 = '#111827';

      let y = 50;

      // 1. Damsole logo at top
      const logoPath = path.join(__dirname, '../..', 'Spireleap-frontend/public/logo.png');
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, left, y, { width: 56, height: 56 });
        doc.fontSize(18).fillColor(GRAY_900).text('Damsole', left + 65, y + 16);
      } else {
        doc.rect(left, y, 56, 56).fillAndStroke('#700E08', '#700E08');
        doc.fillColor('#ffffff').fontSize(24).text('D', left + 18, y + 18, { width: 24, align: 'center' });
        doc.fillColor(GRAY_900).fontSize(18).text('Damsole', left + 65, y + 16);
      }
      y += 70;

      // 2. Customer details
      doc.fontSize(10).fillColor(GRAY_400).text('Customer', left, y);
      y += 16;
      const custName = lead?.contact ? `${lead.contact.firstName || ''} ${lead.contact.lastName || ''}`.trim() || 'Customer' : 'Customer';
      doc.fontSize(12).fillColor(GRAY_900).text(custName || 'Customer', left, y);
      const email = lead?.contact?.email || '';
      const phone = lead?.contact?.phone || '';
      if (email) { y += 16; doc.fontSize(10).fillColor(GRAY_700).text(email, left, y); }
      if (phone) { y += 14; doc.fontSize(10).fillColor(GRAY_700).text(phone, left, y); }
      y += 28;

      // 3. Property basic details
      doc.fontSize(10).fillColor(GRAY_400).text('Property', left, y);
      y += 16;
      doc.fontSize(12).fillColor(GRAY_900).text(property?.title || 'Property', left, y);
      y += 16;
      const location = property?.location?.city || property?.location?.address || property?.location?.state || '—';
      doc.fontSize(10).fillColor(GRAY_700).text(location, left, y);
      y += 14;
      const transType = transaction?.type || 'sale';
      doc.fontSize(10).fillColor(GRAY_700).text(`Type: ${transType.charAt(0).toUpperCase() + transType.slice(1)}`, left, y);
      y += 32;

      // 4. Transaction details: total amount, due amount, receipt ID
      doc.fontSize(10).fillColor(GRAY_400).text('Transaction details', left, y);
      y += 20;

      const currency = payment.currency || 'INR';
      const formatAmount = (n) => `${currency === 'INR' ? '₹' : currency + ' '}${Number(n || 0).toLocaleString()}`;
      const totalAmount = Number(transaction?.amount ?? payment.amount ?? 0);
      const paymentDetails = transaction?.paymentDetails;
      const dueAmount = paymentDetails?.dueAmount ?? Math.max(0, totalAmount - (paymentDetails?.amountPaid ?? (payment.status === 'completed' ? Number(payment.amount ?? 0) : 0)));
      const receiptId = payment.receipt?.number || transaction?._id?.toString().slice(-8).toUpperCase() || payment._id?.toString().slice(-8).toUpperCase() || 'N/A';

      doc.fontSize(11).fillColor(GRAY_700).text('Total amount', left, y);
      doc.fontSize(11).fillColor(GRAY_900).text(formatAmount(totalAmount), left + 120, y);
      y += 22;

      doc.fontSize(11).fillColor(GRAY_700).text('Due amount', left, y);
      doc.fontSize(11).fillColor(GRAY_900).text(formatAmount(dueAmount), left + 120, y);
      y += 22;

      doc.fontSize(11).fillColor(GRAY_700).text('Receipt ID', left, y);
      doc.fontSize(11).fillColor(GRAY_900).text(receiptId, left + 120, y);
      y += 40;

      // Minimal footer
      doc.fontSize(9).fillColor(GRAY_400).text('Thank you. For queries, contact your agent or agency.', left, y, { width: pageWidth });

      if (opts.asBuffer) {
        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));
        const bufferPromise = new Promise((resolve, reject) => {
          doc.on('end', () => resolve(Buffer.concat(chunks)));
          doc.on('error', reject);
        });
        doc.end();
        return bufferPromise;
      }
      doc.end();
      return doc;
    } catch (error) {
      console.error('PDF generation error:', error);
      throw error;
    }
  }

  /**
   * Same receipt PDF as portal download, returned as Buffer for email attachment.
   */
  async generateReceiptPDFBuffer(paymentId) {
    return this.generateReceiptPDF(paymentId, { asBuffer: true });
  }
}

module.exports = new PaymentService();

