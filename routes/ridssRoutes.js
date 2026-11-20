const express = require('express');
const router = express.Router();
const {
    getRidssZones,
    getRidssDashboard,
    getStudentRidssDetail
} = require('../controllers/ridssController');

const { protect, authorize } = require('../middlewares/authMiddleware');

router.get('/zones', protect, getRidssZones);
router.get('/dashboard', protect, authorize('admin', 'staff'), getRidssDashboard);
router.get('/student/:id', protect, authorize('admin', 'staff'), getStudentRidssDetail);

module.exports = router;

