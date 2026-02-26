const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directories exist
const uploadDirs = {
  properties: 'uploads/properties',
  profiles: 'uploads/profiles',
  cms: 'uploads/cms',
  agencies: 'uploads/agencies'
};

// Ensure all upload directories exist
Object.values(uploadDirs).forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Also ensure agencies directory exists
if (!fs.existsSync('uploads/agencies')) {
  fs.mkdirSync('uploads/agencies', { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadPath = 'uploads/';
    
    // Determine upload path based on route path or field name
    const routePath = req.route?.path || req.path || '';
    
    if (routePath.includes('property')) {
      uploadPath = uploadDirs.properties;
    } else if (routePath.includes('profile')) {
      uploadPath = uploadDirs.profiles;
    } else if (routePath.includes('cms')) {
      uploadPath = uploadDirs.cms;
    } else if (file.fieldname === 'propertyImages' || file.fieldname === 'images') {
      uploadPath = uploadDirs.properties;
    } else if (file.fieldname === 'profileImage' || file.fieldname === 'image') {
      uploadPath = uploadDirs.profiles;
    } else if (file.fieldname === 'featuredImage' || file.fieldname === 'bannerImage') {
      uploadPath = uploadDirs.cms;
    }
    
    // Ensure directory exists
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    
    console.log(`Upload destination: ${uploadPath} for field: ${file.fieldname}`);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // Generate unique filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}-${uniqueSuffix}${ext}`);
  }
});

// File filter
const fileFilter = (req, file, cb) => {
  // Allowed file types
  const allowedTypes = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'text/plain': '.txt',
    'application/zip': '.zip',
    'application/x-rar-compressed': '.rar'
  };

  if (allowedTypes[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not allowed`), false);
  }
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 10 // Maximum 10 files per request
  }
});

// Middleware for single file upload
const uploadSingle = (fieldName) => {
  return (req, res, next) => {
    const uploadSingleFile = upload.single(fieldName);
    uploadSingleFile(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ message: 'File too large. Maximum size is 10MB.' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ message: 'Too many files. Maximum is 10 files.' });
        }
        return res.status(400).json({ message: err.message });
      } else if (err) {
        return res.status(400).json({ message: err.message });
      }
      next();
    });
  };
};

// Middleware for multiple file upload
const uploadMultiple = (fieldName, maxCount = 10) => {
  return (req, res, next) => {
    const uploadMultipleFiles = upload.array(fieldName, maxCount);
    uploadMultipleFiles(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        console.error('Multer error:', err.code, err.message);
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ message: 'File too large. Maximum size is 10MB.' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ message: `Too many files. Maximum is ${maxCount} files.` });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ message: `Unexpected field name. Expected: ${fieldName}` });
        }
        return res.status(400).json({ message: err.message || 'File upload error' });
      } else if (err) {
        console.error('Upload error:', err);
        return res.status(400).json({ message: err.message || 'File upload failed' });
      }
      next();
    });
  };
};

// Middleware for mixed file uploads
const uploadFields = (fields) => {
  return (req, res, next) => {
    const uploadFieldsFiles = upload.fields(fields);
    uploadFieldsFiles(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ message: 'File too large. Maximum size is 10MB.' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ message: 'Too many files.' });
        }
        return res.status(400).json({ message: err.message });
      } else if (err) {
        return res.status(400).json({ message: err.message });
      }
      next();
    });
  };
};

// Helper function to delete file
const deleteFile = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error deleting file:', error);
    return false;
  }
};

// Helper function to get file URL
const getFileUrl = (req, filePath) => {
  if (!filePath) return null;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  // Fix path separators for cross-platform compatibility
  const normalizedPath = filePath.replace(/\\/g, '/');
  // Remove 'uploads/' prefix if present as it's already in the static route
  const cleanPath = normalizedPath.replace(/^uploads\//, '');
  return `${baseUrl}/uploads/${cleanPath}`;
};

module.exports = {
  upload,
  uploadSingle,
  uploadMultiple,
  uploadFields,
  deleteFile,
  getFileUrl,
  uploadDirs
};

