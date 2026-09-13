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

// 2. Initialize Express
const app = express();

// 3. Middleware
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
});

// Helper middleware to verify Firebase Auth Token
const authenticateFirebaseUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Auth Verification Error:', error.message);
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
  }
};

// 4. Initialize Sanity Client
const sanityClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || 'production',
  token: process.env.SANITY_WRITE_TOKEN,
  apiVersion: '2024-01-01',
  useCdn: false,
});

const sanityReadClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || 'production',
  apiVersion: '2024-01-01',
  useCdn: true,
});

// ==========================================
// ROUTES
// ==========================================

app.get('/', (req, res) => {
  res.send('Aero Backend Server is running successfully!');
});

// -----------------------------------------
// EVENTS & REGISTRATION ROUTES
// -----------------------------------------

// GET: Fetch all events
app.get('/api/events', async (req, res) => {
  try {
    const query = `
      *[_type == "event"] | order(startDate desc, _createdAt desc) {
        _id,
        title,
        subtitle,
        description,
        status,
        registrationKey,
        ctaLink,
        ctaLabel,
        manualParticipantCount,
        maxCapacity,
        startDate,
        "imageUrl": image.asset->url
      }
    `;
    const events = await sanityReadClient.fetch(query);
    return res.status(200).json({ success: true, events });
  } catch (error) {
    console.error('Error fetching events:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Create or Edit Event
app.post('/api/save-event', authenticateFirebaseUser, upload.single('image'), async (req, res) => {
  try {
    const {
      eventId,
      title,
      subtitle,
      description,
      status,
      registrationKey,
      ctaLink,
      ctaLabel,
      manualParticipantCount,
      currentParticipants,
      maxCapacity,
      startDate,
    } = req.body;
    const file = req.file;

    let imageAsset;
    if (file) {
      imageAsset = await sanityClient.assets.upload('image', file.buffer, {
        filename: file.originalname,
      });
    }

    const countVal = Number(currentParticipants ?? manualParticipantCount ?? 0);
    const capacityVal = Number(maxCapacity ?? 0);

    const eventDoc = {
      _type: 'event',
      title: title || '',
      subtitle: subtitle || 'Aero NITK Registration',
      description: description || '',
      status: status || 'soon',
      registrationKey: registrationKey || 'none',
      ctaLink: ctaLink || '',
      ctaLabel: ctaLabel || 'Open Registration Form',
      manualParticipantCount: isNaN(countVal) ? 0 : countVal,
      maxCapacity: isNaN(capacityVal) ? 0 : capacityVal,
      startDate: startDate || null,
      ...(imageAsset
        ? {
            image: {
              _type: 'image',
              asset: { _type: 'reference', _ref: imageAsset._id },
            },
          }
        : {}),
    };

    const isEditing = eventId && eventId !== 'null' && eventId !== 'undefined' && eventId.trim() !== '';

    let result;
    if (isEditing) {
      result = await sanityClient.patch(eventId).set(eventDoc).commit();
    } else {
      result = await sanityClient.create(eventDoc);
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error saving event:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Bump an event's live participant count in Sanity by 1.
// Called by the public registration form immediately after a successful
// Firestore write, so the admin dashboard / public site reflect live
// registrations without re-querying Firestore on every page load.
//
// No auth here on purpose — the public registration page (not the logged-in
// dashboard) is what calls this. Firestore's `${registrationKey}_registrations`
// collection remains the actual source of truth / audit trail; this number is
// a display mirror. If abuse becomes a real concern, swap the blind .inc(1)
// for a server-side recount against Firestore via firebase-admin, or add
// rate-limiting.
app.post('/api/events/:eventId/increment-count', async (req, res) => {
  try {
    const { eventId } = req.params;
    if (!eventId) {
      return res.status(400).json({ success: false, error: 'Event ID is required' });
    }

    const result = await sanityClient
      .patch(eventId)
      .setIfMissing({ manualParticipantCount: 0 })
      .inc({ manualParticipantCount: 1 })
      .commit();

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error incrementing event count:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE: Remove Event
app.delete('/api/events/:eventId', authenticateFirebaseUser, async (req, res) => {
  try {
    const { eventId } = req.params;
    if (!eventId) {
      return res.status(400).json({ success: false, error: 'Event ID is required' });
    }

    await sanityClient.delete(eventId);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting event:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------------------------
// ALUMNI PAGE & BATCH ROUTES
// -----------------------------------------

app.get('/api/alumni', async (req, res) => {
  try {
    const query = `
      *[_type == "alumni"] | order(batchyear desc) {
        _id,
        batchyear,
        name,
        description,
        "coverUrl": coverimage.asset->url,
        "memberCount": count(images)
      }
    `;
    const batches = await sanityReadClient.fetch(query);
    return res.status(200).json({ success: true, batches });
  } catch (error) {
    console.error('Error fetching alumni batches:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/alumni/:batchyear', async (req, res) => {
  try {
    const { batchyear } = req.params;
    const query = `
      *[_type == "alumni" && (batchyear == $batchyear || _id == $batchyear)][0] {
        _id,
        batchyear,
        name,
        description,
        "coverUrl": coverimage.asset->url,
        "members": images[] {
          _key,
          name,
          role,
          company,
          linkedin,
          "image": image.asset->url
        }
      }
    `;
    const batchData = await sanityReadClient.fetch(query, { batchyear });
    return res.status(200).json({ success: true, batch: batchData || null });
  } catch (error) {
    console.error('Error fetching batch details:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/save-alumni-batch', authenticateFirebaseUser, upload.single('coverImage'), async (req, res) => {
  try {
    const { batchId, batchyear, name, description } = req.body;
    const file = req.file;

    let coverImageAsset;
    if (file) {
      coverImageAsset = await sanityClient.assets.upload('image', file.buffer, {
        filename: file.originalname,
      });
    }

    const batchDoc = {
      _type: 'alumni',
      batchyear: String(batchyear),
      name: name || `Batch ${batchyear}`,
      description: description || '',
      ...(coverImageAsset
        ? {
            coverimage: {
              _type: 'image',
              asset: { _type: 'reference', _ref: coverImageAsset._id },
            },
          }
        : {}),
    };

    const isEditing = batchId && batchId !== 'null' && batchId !== 'undefined' && batchId.trim() !== '';

    let result;
    if (isEditing) {
      result = await sanityClient.patch(batchId).set(batchDoc).commit();
    } else {
      result = await sanityClient.create({ ...batchDoc, images: [] });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error saving batch folder:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/alumni/batch/:batchId', authenticateFirebaseUser, async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!batchId) {
      return res.status(400).json({ success: false, error: 'Batch ID is required' });
    }

    await sanityClient.delete(batchId);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting alumni batch:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/alumni/member', authenticateFirebaseUser, upload.single('image'), async (req, res) => {
  try {
    const { batchId, memberKey, name, role, company, linkedin } = req.body;
    const file = req.file;

    if (!batchId || !name) {
      return res.status(400).json({ success: false, error: 'Batch ID and member name are required' });
    }

    let imageAssetRef = null;
    if (file) {
      const asset = await sanityClient.assets.upload('image', file.buffer, {
        filename: file.originalname,
      });
      imageAssetRef = asset._id;
    }

    const isEditing = memberKey && memberKey !== 'null' && memberKey !== 'undefined';

    if (isEditing) {
      const batchDoc = await sanityClient.getDocument(batchId);
      if (!batchDoc) {
        return res.status(404).json({ success: false, error: 'Batch not found' });
      }

      const updatedMembers = (batchDoc.images || []).map((m) => {
        if (m._key === memberKey) {
          return {
            ...m,
            name,
            role: role || '',
            company: company || '',
            linkedin: linkedin || '',
            ...(imageAssetRef
              ? {
                  image: {
                    _type: 'image',
                    asset: { _type: 'reference', _ref: imageAssetRef },
                  },
                }
              : m.image),
          };
        }
        return m;
      });

      const result = await sanityClient.patch(batchId).set({ images: updatedMembers }).commit();
      return res.status(200).json({ success: true, data: result });
    } else {
      const newMemberItem = {
        _key: Math.random().toString(36).substring(2, 9),
        name,
        role: role || '',
        company: company || '',
        linkedin: linkedin || '',
        ...(imageAssetRef
          ? {
              image: {
                _type: 'image',
                asset: { _type: 'reference', _ref: imageAssetRef },
              },
            }
          : {}),
      };

      const result = await sanityClient
        .patch(batchId)
        .setIfMissing({ images: [] })
        .append('images', [newMemberItem])
        .commit();

      return res.status(200).json({ success: true, data: result });
    }
  } catch (error) {
    console.error('Error saving alumni member:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/alumni/delete-member', authenticateFirebaseUser, async (req, res) => {
  try {
    const { batchId, memberKey } = req.body;
    if (!batchId || !memberKey) {
      return res.status(400).json({ success: false, error: 'Batch ID and Member Key are required' });
    }

    const result = await sanityClient
      .patch(batchId)
      .unset([`images[_key == "${memberKey}"]`])
      .commit();

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error deleting alumni member:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ------------------------------------------
// TEAM ROUTES
// ------------------------------------------

app.get('/api/team', async (req, res) => {
  try {
    const query = `
      *[_type == "teamMember"] | order(_createdAt desc) {
        _id,
        name,
        role,
        teamType,
        subsystem,
        linkedIn,
        "imageUrl": image.asset->url
      }
    `;
    const teamMembers = await sanityClient.fetch(query);
    return res.status(200).json(teamMembers);
  } catch (error) {
    console.error('Error fetching team members:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/team', authenticateFirebaseUser, upload.single('image'), async (req, res) => {
  try {
    const { name, role, teamType, subsystem, linkedIn } = req.body;
    const file = req.file;

    if (!name || !file) {
      return res.status(400).json({ success: false, error: 'Name and photo image are required' });
    }

    const imageAsset = await sanityClient.assets.upload('image', file.buffer, {
      filename: file.originalname,
    });

    const teamDoc = {
      _type: 'teamMember',
      name,
      role,
      teamType: teamType || 'Member',
      subsystem,
      linkedIn: linkedIn || '',
      image: {
        _type: 'image',
        asset: {
          _type: 'reference',
          _ref: imageAsset._id,
        },
      },
    };

    const result = await sanityClient.create(teamDoc);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error adding team member:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/team/:id', authenticateFirebaseUser, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Member ID is required' });
    }

    await sanityClient.delete(id);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting team member:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ------------------------------------------
// GALLERY ROUTES
// ------------------------------------------

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

app.get('/api/gallery-summary', async (req, res) => {
  try {
    const query = `
      *[_type == "galleryFolder"] | order(_createdAt desc) {
        _id,
        name,
        description,
        "cover": coverImage.asset->url,
        "imageCount": count(images)
      }
    `;
    const folders = await sanityReadClient.fetch(query);
    return res.status(200).json({ success: true, folders });
  } catch (error) {
    console.error('Error fetching gallery summary:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/gallery-folders/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;
    const query = `
      *[_type == "galleryFolder" && _id == $folderId][0] {
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
    const folder = await sanityReadClient.fetch(query, { folderId });
    return res.status(200).json({ success: true, folder: folder || null });
  } catch (error) {
    console.error('Error fetching gallery folder detail:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/save-gallery-folder', authenticateFirebaseUser, upload.single('coverImage'), async (req, res) => {
  try {
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

app.post('/api/delete-gallery-folder', authenticateFirebaseUser, async (req, res) => {
  try {
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

app.post('/api/upload-gallery-images', authenticateFirebaseUser, upload.array('images'), async (req, res) => {
  try {
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

app.post('/api/delete-gallery-image', authenticateFirebaseUser, async (req, res) => {
  try {
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
