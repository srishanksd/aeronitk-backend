require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');

const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { createClient } = require('@sanity/client');

// 1. Initialize Firebase Admin
try {
  const serviceAccount = require('./serviceAccountKey.json');
  initializeApp({
    credential: cert(serviceAccount),
  });
  console.log('Firebase Admin initialized successfully using serviceAccountKey.json');
} catch (error) {
  console.error('Firebase Admin initialization failed:', error.message);
  process.exit(1);
}

// 2. Initialize Express (MUST be BEFORE any routes are defined)
const app = express();

// 3. Middleware
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
});

// 4. Initialize Sanity Client
const sanityClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || 'production',
  token: process.env.SANITY_WRITE_TOKEN,
  apiVersion: '2024-01-01',
  useCdn: false,
});

// ==========================================
// ROUTES
// ==========================================

// Test route
app.get('/', (req, res) => {
  res.send('Aero Backend Server is running successfully!');
});

// GET: Fetch all gallery folders
app.get('/api/gallery-folders', async (req, res) => {
  try {
    const query = `
      *[_type == "galleryFolder"] | order(_createdAt desc) {
        _id,
        name,
        description,
        "cover": coverImage.asset->url,
        images[]{
          _key,
          "src": image.asset->url
        }
      }
    `;
    const galleryFolders = await sanityClient.fetch(query);
    return res.status(200).json({ success: true, folders: galleryFolders });
  } catch (error) {
    console.error('Error fetching gallery folders:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Create or Update Gallery Folder
app.post('/api/save-gallery-folder', upload.single('coverImage'), async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    await getAuth().verifyIdToken(idToken);

    const { folderId, name, description } = req.body;
    const file = req.file;

    let coverImageAsset;
    if (file) {
      coverImageAsset = await sanityClient.assets.upload('image', file.buffer, {
        filename: file.originalname,
      });
    }

    const folderDoc = {
      _type: 'galleryFolder',
      name,
      description: description || '',
      ...(coverImageAsset
        ? {
            coverImage: {
              _type: 'image',
              asset: { _type: 'reference', _ref: coverImageAsset._id },
            },
          }
        : {}),
    };

    const isEditing = folderId && folderId !== 'null' && folderId !== 'undefined' && folderId.trim() !== '';

    let result;
    if (isEditing) {
      result = await sanityClient.patch(folderId).set(folderDoc).commit();
    } else {
      result = await sanityClient.create(folderDoc);
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error saving gallery folder:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Delete Gallery Folder
app.post('/api/delete-gallery-folder', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    await getAuth().verifyIdToken(idToken);

    const { folderId } = req.body;
    if (!folderId) {
      return res.status(400).json({ success: false, error: 'Folder ID is required' });
    }

    await sanityClient.delete(folderId);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting gallery folder:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Upload multiple images to a gallery folder
app.post('/api/upload-gallery-images', upload.array('images'), async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    await getAuth().verifyIdToken(idToken);

    const { folderId } = req.body;
    const files = req.files;

    if (!folderId || !files || files.length === 0) {
      return res.status(400).json({ success: false, error: 'Folder ID and images are required' });
    }

    const uploadedImageItems = await Promise.all(
      files.map(async (file) => {
        const asset = await sanityClient.assets.upload('image', file.buffer, {
          filename: file.originalname,
        });
        return {
          _key: Math.random().toString(36).substring(2, 9),
          image: {
            _type: 'image',
            asset: {
              _type: 'reference',
              _ref: asset._id,
            },
          },
        };
      })
    );

    const result = await sanityClient
      .patch(folderId)
      .setIfMissing({ images: [] })
      .append('images', uploadedImageItems)
      .commit();

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error uploading gallery images:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Delete individual image from a gallery folder
app.post('/api/delete-gallery-image', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    await getAuth().verifyIdToken(idToken);

    const { folderId, imageId } = req.body;
    if (!folderId || !imageId) {
      return res.status(400).json({ success: false, error: 'Folder ID and Image ID are required' });
    }

    const result = await sanityClient
      .patch(folderId)
      .unset([`images[_key == "${imageId}"]`])
      .commit();

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error deleting gallery image:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 5. Start Server
// ==========================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});