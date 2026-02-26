const subscriptionService = require('../services/subscriptionService');

class SubscriptionScheduler {
    constructor() {
        this.intervalId = null;
        this.isRunning = false;
    }

    start() {
        if (this.isRunning) {
            console.log('Subscription scheduler is already running');
            return;
        }

        console.log('Starting subscription scheduler...');
        this.isRunning = true;

        // Run immediately on start
        this.checkSubscriptions();

        // Run every day
        // The user wants it to be "after 30 days", checking once a day is usually enough for daily validity.
        // If higher precision is needed, it can be run every hour.
        this.intervalId = setInterval(() => {
            this.checkSubscriptions();
        }, 24 * 60 * 60 * 1000); // 24 hours
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        console.log('Subscription scheduler stopped');
    }

    async checkSubscriptions() {
        try {
            console.log('Running subscription expiry checks...');
            const result = await subscriptionService.deactivateExpiredSubscriptions();
            if (result.deactivatedCount > 0) {
                console.log(`Deactivation job: ${result.deactivatedCount} subscriptions deactivated`);
            }
        } catch (error) {
            console.error('Error running subscription scheduler:', error);
        }
    }
}

// Create singleton instance
const subscriptionScheduler = new SubscriptionScheduler();

module.exports = subscriptionScheduler;
