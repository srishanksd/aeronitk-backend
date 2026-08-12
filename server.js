require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');

const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const { createClient } = require('@sanity/client');

// ==========================================
// 1. Initialize Firebase Admin
// ==========================================

try {
  const serviceAccount = require('./serviceAccountKey.json');

  initializeApp({
    credential: cert(serviceAccount),
  });

  console.log(
    'Firebase Admin initialized successfully using serviceAccountKey.json'
  );
} catch (error) {
  console.error(
    'Firebase Admin initialization failed:',
    error.message
  );

  process.exit(1);
}

// ==========================================
// 2. Initialize Express
// ==========================================

const app = express();

// ==========================================
// 3. Middleware
// ==========================================

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
});

// ==========================================
// 4. Initialize Sanity Client
// ==========================================

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

// ==========================================
// GET: Fetch all events from Sanity
// ==========================================

app.get('/api/events', async (req, res) => {
  try {
    const query = `
      *[_type == "event"] | order(_createdAt desc) {
        _id,
        title,
        description,
        "imageUrl": image.asset->url,
        registrationKey,
        manualParticipantCount,
        maxCapacity,
        status,
        startDate
      }
    `;

    const events = await sanityClient.fetch(query);

    return res.status(200).json({
      success: true,
      data: events,
    });
  } catch (error) {
    console.error('Error fetching events:', error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==========================================
// POST: Create or Update Event
// Protected by Firebase Authentication
// ==========================================

app.post(
  '/api/save-event',
  upload.single('image'),
  async (req, res) => {
    try {
      // ------------------------------------------
      // Verify Firebase ID token
      // ------------------------------------------

      const authHeader = req.headers.authorization;

      if (
        !authHeader ||
        !authHeader.startsWith('Bearer ')
      ) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized: No token provided',
        });
      }

      const idToken = authHeader.split('Bearer ')[1];

      await getAuth().verifyIdToken(idToken);

      // ------------------------------------------
      // Get event data
      // ------------------------------------------

      const {
        eventId,
        title,
        description,
        registrationKey,
        manualParticipantCount,
        maxCapacity,
        status,
        startDate,
      } = req.body;

      const file = req.file;

      // ------------------------------------------
      // Upload image to Sanity
      // ------------------------------------------

      let imageAsset;

      if (file) {
        imageAsset = await sanityClient.assets.upload(
          'image',
          file.buffer,
          {
            filename: file.originalname,
          }
        );
      }

      // ------------------------------------------
      // Create event document
      // ------------------------------------------

      const eventDoc = {
        _type: 'event',

        title,

        description,

        registrationKey:
          registrationKey || 'none',

        manualParticipantCount:
          Number(manualParticipantCount) || 0,

        ...(maxCapacity
          ? {
              maxCapacity: Number(maxCapacity),
            }
          : {}),

        status: status || 'soon',

        ...(startDate
          ? {
              startDate,
            }
          : {}),

        ...(imageAsset
          ? {
              image: {
                _type: 'image',
                asset: {
                  _type: 'reference',
                  _ref: imageAsset._id,
                },
              },
            }
          : {}),
      };

      // ------------------------------------------
      // Create OR update event
      // ------------------------------------------

      let result;

      if (eventId && eventId.trim() !== '') {
        result = await sanityClient
          .patch(eventId)
          .set(eventDoc)
          .commit();
      } else {
        result = await sanityClient.create(eventDoc);
      }

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('Error saving event:', error);

      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// ==========================================
// 5. Start Server
// ==========================================

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});