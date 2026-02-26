const crypto = require('crypto');

class EncryptionService {
  constructor() {
    // Get encryption key from environment or use default (in production, use strong key)
    this.algorithm = 'aes-256-gcm';
    this.key = process.env.ENCRYPTION_KEY || crypto.scryptSync('default-key-change-in-production', 'salt', 32);
    this.enabled = process.env.ENABLE_DATA_ENCRYPTION === 'true';
  }

  /**
   * Encrypt sensitive data
   */
  encrypt(text) {
    if (!this.enabled || !text) {
      return text; // Return as-is if encryption disabled or empty
    }

    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
      
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const authTag = cipher.getAuthTag();
      
      // Return encrypted data with IV and auth tag
      return {
        encrypted: encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
      };
    } catch (error) {
      console.error('Encryption error:', error);
      return text; // Return original on error
    }
  }

  /**
   * Decrypt sensitive data
   */
  decrypt(encryptedData) {
    if (!this.enabled || !encryptedData) {
      return encryptedData; // Return as-is if encryption disabled or empty
    }

    // If it's not an encrypted object, return as-is (backward compatibility)
    if (typeof encryptedData === 'string') {
      return encryptedData;
    }

    if (!encryptedData.encrypted || !encryptedData.iv || !encryptedData.authTag) {
      return encryptedData; // Invalid format, return as-is
    }

    try {
      const iv = Buffer.from(encryptedData.iv, 'hex');
      const authTag = Buffer.from(encryptedData.authTag, 'hex');
      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      console.error('Decryption error:', error);
      return null; // Return null on error
    }
  }

  /**
   * Encrypt lead contact information
   */
  encryptLeadContact(contact) {
    if (!this.enabled) {
      return contact;
    }

    const encrypted = { ...contact };
    
    // Encrypt sensitive fields
    if (contact.email) {
      encrypted.email = this.encrypt(contact.email);
    }
    if (contact.phone) {
      encrypted.phone = this.encrypt(contact.phone);
    }
    if (contact.alternatePhone) {
      encrypted.alternatePhone = this.encrypt(contact.alternatePhone);
    }
    
    return encrypted;
  }

  /**
   * Decrypt lead contact information
   */
  decryptLeadContact(contact) {
    if (!this.enabled || !contact) {
      return contact;
    }

    const decrypted = { ...contact };
    
    // Decrypt sensitive fields
    if (contact.email && typeof contact.email === 'object') {
      decrypted.email = this.decrypt(contact.email);
    }
    if (contact.phone && typeof contact.phone === 'object') {
      decrypted.phone = this.decrypt(contact.phone);
    }
    if (contact.alternatePhone && typeof contact.alternatePhone === 'object') {
      decrypted.alternatePhone = this.decrypt(contact.alternatePhone);
    }
    
    return decrypted;
  }
}

module.exports = new EncryptionService();

