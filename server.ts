import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_ACADEMY_SETTINGS, INITIAL_COURSES } from './src/data/initialAcademyData.ts';
import type { AcademySettings, Course, Lesson, PaymentMethod, PaymentRecord, PaymentStatus } from './src/types/academy.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, 'data');
const VIDEOS_DIR = path.resolve(DATA_DIR, 'videos');
const DB_FILE = path.resolve(DATA_DIR, 'academy.json');

interface AcademyDatabase {
  courses: Course[];
  payments: PaymentRecord[];
  settings: AcademySettings;
}

function ensureStorage(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(VIDEOS_DIR)) {
    fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    const initialDb: AcademyDatabase = {
      courses: INITIAL_COURSES,
      payments: [],
      settings: DEFAULT_ACADEMY_SETTINGS,
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2), 'utf-8');
  }
}

function readDb(): AcademyDatabase {
  ensureStorage();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AcademyDatabase>;
    return {
      courses: Array.isArray(parsed.courses) && parsed.courses.length > 0 ? parsed.courses : INITIAL_COURSES,
      payments: Array.isArray(parsed.payments) ? parsed.payments : [],
      settings: parsed.settings ? { ...DEFAULT_ACADEMY_SETTINGS, ...parsed.settings } : DEFAULT_ACADEMY_SETTINGS,
    };
  } catch {
    return {
      courses: INITIAL_COURSES,
      payments: [],
      settings: DEFAULT_ACADEMY_SETTINGS,
    };
  }
}

function writeDb(db: AcademyDatabase): void {
  ensureStorage();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

function sanitizeSettings(settings: AcademySettings) {
  return {
    academyNameUr: settings.academyNameUr,
    academyNameEn: settings.academyNameEn,
    jazzCashNumber: settings.jazzCashNumber,
    jazzCashTitle: settings.jazzCashTitle,
    easypaisaNumber: settings.easypaisaNumber,
    easypaisaTitle: settings.easypaisaTitle,
    intlMerchantLabel: settings.intlMerchantLabel,
    bundlePricePkr: settings.bundlePricePkr,
    bundlePriceUsd: settings.bundlePriceUsd,
  };
}

function generateReceiptCode(): string {
  const randomPart = Math.floor(100000 + Math.random() * 900000);
  return `DUA-${randomPart}`;
}

function getUnlockedCoursesForContact(payments: PaymentRecord[], contactOrReceipt: string): string[] {
  const normalized = contactOrReceipt.trim().toLowerCase();
  if (!normalized) return [];
  const matching = payments.filter(
    (p) =>
      p.status === 'verified' &&
      (p.studentContact.trim().toLowerCase() === normalized ||
        (p.studentEmail && p.studentEmail.trim().toLowerCase() === normalized) ||
        p.receiptCode.trim().toLowerCase() === normalized)
  );
  const unlocked = new Set<string>();
  for (const p of matching) {
    unlocked.add(p.courseId);
  }
  return Array.from(unlocked);
}

ensureStorage();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureStorage();
    cb(null, VIDEOS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '.mp4').toLowerCase() || '.mp4';
    const safeBase = path
      .basename(file.originalname || 'lesson', ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);
    cb(null, `${Date.now()}_${safeBase || 'lesson'}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 250 * 1024 * 1024, // 250 MB
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'application/octet-stream'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowed.includes(file.mimetype) || ['.mp4', '.webm', '.mov', '.m4v'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only MP4, WebM, and MOV video files are supported.'));
    }
  },
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Public academy data
  app.get('/api/academy', (_req: Request, res: Response) => {
    const db = readDb();
    res.json({
      courses: db.courses,
      settings: sanitizeSettings(db.settings),
      bundlePricePkr: db.settings.bundlePricePkr,
      bundlePriceUsd: db.settings.bundlePriceUsd,
    });
  });

  // Checkout payment (JazzCash, Easypaisa, International ATM Card)
  app.post('/api/payments/checkout', (req: Request, res: Response) => {
    const body = req.body as {
      studentName?: string;
      studentContact?: string;
      studentEmail?: string;
      country?: string;
      courseId?: string;
      method?: PaymentMethod;
      transactionRef?: string;
      cardBrand?: string;
    };

    const studentName = (body.studentName || '').trim();
    const studentContact = (body.studentContact || '').trim();
    const studentEmail = (body.studentEmail || '').trim();
    const country = (body.country || 'Pakistan').trim();
    const courseId = (body.courseId || '').trim();
    const method = body.method;
    const transactionRef = (body.transactionRef || '').trim();

    if (!studentName || !studentContact || !courseId || !method) {
      res.status(400).json({ error: 'براہ کرم تمام ضروری معلومات درج کریں۔ / Please fill in all required fields.' });
      return;
    }

    if (!['jazzcash', 'easypaisa', 'atm_card'].includes(method)) {
      res.status(400).json({ error: 'Invalid payment method.' });
      return;
    }

    const db = readDb();
    let courseTitleUr = 'مکمل اکیڈمی آل-ان-ون بنڈل (تمام 6 کورسز)';
    let courseTitleEn = 'Complete Academy All-Access Bundle (All Courses)';
    let amount = method === 'atm_card' ? db.settings.bundlePriceUsd : db.settings.bundlePricePkr;

    if (courseId !== 'ALL_BUNDLE') {
      const foundCourse = db.courses.find((c) => c.id === courseId);
      if (!foundCourse) {
        res.status(404).json({ error: 'Course not found.' });
        return;
      }
      courseTitleUr = foundCourse.titleUr;
      courseTitleEn = foundCourse.titleEn;
      amount = method === 'atm_card' ? foundCourse.priceUsd : foundCourse.pricePkr;
    }

    if ((method === 'jazzcash' || method === 'easypaisa') && transactionRef.length < 4) {
      res.status(400).json({ error: 'براہ کرم درست ٹرانزیکشن آئی ڈی (TID) درج کریں۔' });
      return;
    }

    const payment: PaymentRecord = {
      id: `pay_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      receiptCode: generateReceiptCode(),
      studentName,
      studentContact,
      studentEmail: studentEmail || undefined,
      country,
      courseId,
      courseTitleUr,
      courseTitleEn,
      method,
      currency: method === 'atm_card' ? 'USD' : 'PKR',
      amount,
      transactionRef: transactionRef || `CARD-${Math.floor(1000 + Math.random() * 9000)}`,
      cardBrand: body.cardBrand,
      status: 'verified',
      createdAt: new Date().toISOString(),
    };

    db.payments.unshift(payment);
    writeDb(db);

    const unlockedCourseIds =
      courseId === 'ALL_BUNDLE' ? ['ALL_BUNDLE', ...db.courses.map((c) => c.id)] : [courseId];

    res.json({
      payment,
      unlockedCourseIds,
    });
  });

  // Restore student purchases via phone, email, or receipt code
  app.post('/api/payments/restore', (req: Request, res: Response) => {
    const { query } = req.body as { query?: string };
    const db = readDb();
    const unlocked = getUnlockedCoursesForContact(db.payments, query || '');
    const expanded = unlocked.includes('ALL_BUNDLE')
      ? ['ALL_BUNDLE', ...db.courses.map((c) => c.id)]
      : unlocked;

    const latestPayment = db.payments.find(
      (p) =>
        p.status === 'verified' &&
        (p.studentContact.trim().toLowerCase() === (query || '').trim().toLowerCase() ||
          (p.studentEmail && p.studentEmail.trim().toLowerCase() === (query || '').trim().toLowerCase()) ||
          p.receiptCode.trim().toLowerCase() === (query || '').trim().toLowerCase())
    );

    res.json({
      unlockedCourseIds: expanded,
      studentName: latestPayment?.studentName || null,
      receiptCode: latestPayment?.receiptCode || null,
    });
  });

  // Stream uploaded video files with HTTP Range support
  app.get('/api/videos/stream/:filename', (req: Request, res: Response) => {
    const safeName = path.basename(req.params.filename || '');
    const filePath = path.resolve(VIDEOS_DIR, safeName);

    if (!filePath.startsWith(VIDEOS_DIR) || !fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Video file not found.' });
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const ext = path.extname(safeName).toLowerCase();
    const mimeType =
      ext === '.webm'
        ? 'video/webm'
        : ext === '.mov'
          ? 'video/quicktime'
          : 'video/mp4';

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  // Teacher passcode verification
  app.post('/api/teacher/verify', (req: Request, res: Response) => {
    const { passcode } = req.body as { passcode?: string };
    const db = readDb();
    if ((passcode || '').trim() === db.settings.teacherPasscode) {
      res.json({ authenticated: true });
    } else {
      res.status(401).json({ authenticated: false, error: 'غلط استاد پاس کوڈ / Invalid teacher passcode' });
    }
  });

  function requireTeacherAuth(req: Request, res: Response): AcademyDatabase | null {
    const passcode = String(req.headers['x-teacher-passcode'] || '').trim();
    const db = readDb();
    if (passcode !== db.settings.teacherPasscode) {
      res.status(401).json({ error: 'Unauthorized teacher session.' });
      return null;
    }
    return db;
  }

  // Teacher dashboard data
  app.get('/api/teacher/dashboard', (req: Request, res: Response) => {
    const db = requireTeacherAuth(req, res);
    if (!db) return;

    const totalPkr = db.payments
      .filter((p) => p.status === 'verified' && p.currency === 'PKR')
      .reduce((sum, p) => sum + p.amount, 0);
    const totalUsd = db.payments
      .filter((p) => p.status === 'verified' && p.currency === 'USD')
      .reduce((sum, p) => sum + p.amount, 0);

    res.json({
      courses: db.courses,
      payments: db.payments,
      settings: db.settings,
      revenue: { totalPkr, totalUsd },
    });
  });

  // Upload a new lesson video (file upload OR external URL)
  app.post('/api/teacher/upload-video', upload.single('videoFile'), (req: Request, res: Response) => {
    const db = requireTeacherAuth(req, res);
    if (!db) return;

    const body = req.body as {
      courseId?: string;
      titleUr?: string;
      titleEn?: string;
      duration?: string;
      descriptionUr?: string;
      descriptionEn?: string;
      arabicVerse?: string;
      urduTranslation?: string;
      tajweedFocusUr?: string;
      externalVideoUrl?: string;
    };

    const courseId = (body.courseId || '').trim();
    const courseIndex = db.courses.findIndex((c) => c.id === courseId);
    if (courseIndex === -1) {
      res.status(404).json({ error: 'Selected course not found.' });
      return;
    }

    const titleUr = (body.titleUr || '').trim();
    const titleEn = (body.titleEn || titleUr).trim();
    if (!titleUr) {
      res.status(400).json({ error: 'براہ کرم سبق کا عنوان درج کریں۔' });
      return;
    }

    const file = req.file;
    const externalUrl = (body.externalVideoUrl || '').trim();

    if (!file && !externalUrl) {
      res.status(400).json({ error: 'براہ کرم ویڈیو فائل اپ لوڈ کریں یا ویڈیو لنک درج کریں۔' });
      return;
    }

    const targetCourse = db.courses[courseIndex];
    const nextOrder = targetCourse.lessons.length + 1;

    const newLesson: Lesson = {
      id: `lesson_${Date.now()}`,
      courseId,
      order: nextOrder,
      titleUr,
      titleEn,
      duration: (body.duration || '15:00').trim(),
      descriptionUr: (body.descriptionUr || 'استاد کی جانب سے اپ لوڈ کردہ ویڈیو سبق۔').trim(),
      descriptionEn: (body.descriptionEn || 'Video lesson uploaded by Academy instructor.').trim(),
      arabicVerse: body.arabicVerse?.trim() || undefined,
      urduTranslation: body.urduTranslation?.trim() || undefined,
      tajweedFocusUr: body.tajweedFocusUr?.trim() || undefined,
      videoType: file ? 'uploaded' : 'external',
      videoUrl: file ? `/api/videos/stream/${encodeURIComponent(file.filename)}` : externalUrl,
      videoFileName: file?.filename,
      uploadedAt: new Date().toISOString(),
      isPaidOnly: true,
    };

    targetCourse.lessons.push(newLesson);
    db.courses[courseIndex] = targetCourse;
    writeDb(db);

    res.json({ lesson: newLesson, course: targetCourse });
  });

  // Delete a lesson
  app.delete('/api/teacher/lessons/:courseId/:lessonId', (req: Request, res: Response) => {
    const db = requireTeacherAuth(req, res);
    if (!db) return;

    const { courseId, lessonId } = req.params;
    const courseIndex = db.courses.findIndex((c) => c.id === courseId);
    if (courseIndex === -1) {
      res.status(404).json({ error: 'Course not found.' });
      return;
    }

    const lesson = db.courses[courseIndex].lessons.find((l) => l.id === lessonId);
    if (lesson?.videoFileName) {
      const filePath = path.resolve(VIDEOS_DIR, path.basename(lesson.videoFileName));
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    db.courses[courseIndex].lessons = db.courses[courseIndex].lessons
      .filter((l) => l.id !== lessonId)
      .map((l, idx) => ({ ...l, order: idx + 1 }));

    writeDb(db);
    res.json({ courses: db.courses });
  });

  // Add a new Quran course
  app.post('/api/teacher/courses', (req: Request, res: Response) => {
    const db = requireTeacherAuth(req, res);
    if (!db) return;

    const body = req.body as {
      titleUr?: string;
      titleEn?: string;
      subtitleUr?: string;
      descriptionUr?: string;
      instructorUr?: string;
      pricePkr?: number;
      priceUsd?: number;
      durationWeeks?: number;
      category?: Course['category'];
    };

    if (!body.titleUr?.trim()) {
      res.status(400).json({ error: 'Course Urdu title is required.' });
      return;
    }

    const newCourse: Course = {
      id: `course-${Date.now()}`,
      slug: `course-${Date.now()}`,
      category: body.category || 'nazra',
      titleUr: body.titleUr.trim(),
      titleEn: (body.titleEn || body.titleUr).trim(),
      subtitleUr: (body.subtitleUr || 'آن لائن مکمل ویڈیو کورس').trim(),
      subtitleEn: 'Complete Online Video Course',
      descriptionUr: (body.descriptionUr || 'دعا آن لائن قرآن اکیڈمی کا مکمل ویڈیو کورس۔').trim(),
      descriptionEn: 'Complete structured Quran video course from Dua Online Quran Academy.',
      instructorUr: (body.instructorUr || 'قاری محمد طارق محمود').trim(),
      instructorEn: 'Academy Senior Instructor',
      levelUr: 'تمام سطوح',
      levelEn: 'All Levels',
      durationWeeks: Number(body.durationWeeks) || 12,
      pricePkr: Number(body.pricePkr) || 3500,
      priceUsd: Number(body.priceUsd) || 20,
      thumbnailUrl: '/src/assets/images/course_tajweed_qaida_1795176399940.jpg',
      highlightsUr: [
        'مکمل ریکارڈ شدہ ویڈیو اسباق',
        'تجوید اور تلفظ کی خصوصی رہنمائی',
        'لائف ٹائم ویڈیو رسائی',
      ],
      highlightsEn: [
        'Complete recorded video lessons',
        'Guided Tajweed & pronunciation',
        'Full access after enrollment',
      ],
      lessons: [],
    };

    db.courses.push(newCourse);
    writeDb(db);
    res.json({ course: newCourse, courses: db.courses });
  });

  // Update settings & course pricing
  app.put('/api/teacher/settings', (req: Request, res: Response) => {
    const db = requireTeacherAuth(req, res);
    if (!db) return;

    const body = req.body as {
      settings?: Partial<AcademySettings>;
      coursePricing?: Array<{ id: string; pricePkr: number; priceUsd: number }>;
    };

    if (body.settings) {
      db.settings = {
        ...db.settings,
        ...body.settings,
      };
    }

    if (Array.isArray(body.coursePricing)) {
      for (const item of body.coursePricing) {
        const idx = db.courses.findIndex((c) => c.id === item.id);
        if (idx !== -1) {
          db.courses[idx].pricePkr = Math.max(0, Number(item.pricePkr) || db.courses[idx].pricePkr);
          db.courses[idx].priceUsd = Math.max(0, Number(item.priceUsd) || db.courses[idx].priceUsd);
        }
      }
    }

    writeDb(db);
    res.json({ settings: db.settings, courses: db.courses });
  });

  // Update payment status (verified / revoked)
  app.post('/api/teacher/payments/:paymentId/status', (req: Request, res: Response) => {
    const db = requireTeacherAuth(req, res);
    if (!db) return;

    const { paymentId } = req.params;
    const { status } = req.body as { status?: PaymentStatus };
    if (!status || !['verified', 'pending', 'revoked'].includes(status)) {
      res.status(400).json({ error: 'Invalid payment status.' });
      return;
    }

    const idx = db.payments.findIndex((p) => p.id === paymentId);
    if (idx === -1) {
      res.status(404).json({ error: 'Payment record not found.' });
      return;
    }

    db.payments[idx].status = status;
    writeDb(db);
    res.json({ payment: db.payments[idx], payments: db.payments });
  });

  // Vite middleware in dev, static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dua Online Quran Academy server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
