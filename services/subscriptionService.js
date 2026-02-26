const Subscription = require('../models/Subscription');

/**
 * Service to handle subscription-related operations
 */
class SubscriptionService {
    /**
     * Deactivates all subscriptions that have passed their endedAt date
     * @returns {Promise<{ deactivatedCount: number }>}
     */
    async deactivateExpiredSubscriptions() {
        try {
            const now = new Date();

            // Find active subscriptions where endedAt is less than now
            const expiredSubscriptions = await Subscription.find({
                isActive: true,
                endedAt: { $lt: now }
            });

            if (expiredSubscriptions.length === 0) {
                return { deactivatedCount: 0 };
            }

            // Update them to isActive: false
            const result = await Subscription.updateMany(
                {
                    isActive: true,
                    endedAt: { $lt: now }
                },
                {
                    $set: { isActive: false }
                }
            );

            console.log(`Deactivated ${result.modifiedCount} expired subscriptions`);
            return { deactivatedCount: result.modifiedCount };
        } catch (error) {
            console.error('Error deactivating expired subscriptions:', error);
            throw error;
        }
    }
}

module.exports = new SubscriptionService();
