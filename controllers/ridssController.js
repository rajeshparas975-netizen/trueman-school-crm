const Student = require('../models/Student');
const Workshop = require('../models/Workshop');
const Setting = require('../models/Setting');
const Attendance = require('../models/Attendance');

const RIDSS_ZONES = [
    'Social',
    'Intellectual',
    'Physical',
    'Occupational',
    'Financial',
    'Spiritual',
    'Emotional',
    'Environmental'
];

/**
 * Smart zone detector:
 * 1. Checks workshop explicit zone
 * 2. Checks workshop name keywords
 * 3. Defaults to 'Social'
 */
function detectZone(workshopName, explicitZone) {
    if (explicitZone && RIDSS_ZONES.includes(explicitZone)) {
        return explicitZone;
    }

    const name = (workshopName || '').toLowerCase();
    if (name.includes('financ') || name.includes('money') || name.includes('budget') || name.includes('credit') || name.includes('tax') || name.includes('bank') || name.includes('saving')) {
        return 'Financial';
    }
    if (name.includes('intellect') || name.includes('learn') || name.includes('tech') || name.includes('skill') || name.includes('comput') || name.includes('code') || name.includes('read') || name.includes('math') || name.includes('academic') || name.includes('educat') || name.includes('literacy')) {
        return 'Intellectual';
    }
    if (name.includes('physic') || name.includes('health') || name.includes('fit') || name.includes('nutrit') || name.includes('exercis') || name.includes('sport') || name.includes('hygiene') || name.includes('med') || name.includes('body')) {
        return 'Physical';
    }
    if (name.includes('occupat') || name.includes('career') || name.includes('job') || name.includes('work') || name.includes('resume') || name.includes('interview') || name.includes('trade') || name.includes('employ')) {
        return 'Occupational';
    }
    if (name.includes('spirit') || name.includes('faith') || name.includes('meditat') || name.includes('mindful') || name.includes('pray') || name.includes('purpos') || name.includes('soul')) {
        return 'Spiritual';
    }
    if (name.includes('emot') || name.includes('mental') || name.includes('well') || name.includes('stress') || name.includes('therap') || name.includes('cop') || name.includes('counsel') || name.includes('trauma')) {
        return 'Emotional';
    }
    if (name.includes('environ') || name.includes('nature') || name.includes('green') || name.includes('clean') || name.includes('sustain') || name.includes('home') || name.includes('hous') || name.includes('room') || name.includes('eco')) {
        return 'Environmental';
    }
    if (name.includes('socia') || name.includes('communit') || name.includes('relat') || name.includes('peer') || name.includes('team') || name.includes('group') || name.includes('family') || name.includes('network')) {
        return 'Social';
    }

    return 'Social'; // Clean fallback
}

/**
 * @desc    Get RIDSS list of all 8 wellness zones
 * @route   GET /api/ridss/zones
 * @access  Private
 */
const getRidssZones = async (req, res) => {
    return res.status(200).json({
        success: true,
        zones: RIDSS_ZONES,
        milestone: 250
    });
};

/**
 * @desc    Get RIDSS Point Tracking Dashboard Data
 * @route   GET /api/ridss/dashboard
 * @access  Private/Admin/Staff
 */
const getRidssDashboard = async (req, res) => {
    try {
        const organizationId = req.user.organizationId;

        // 1. Fetch Organization Milestone (Default 250)
        let milestone = 250;
        try {
            const orgSetting = await Setting.findOne({ organizationId });
            if (orgSetting && orgSetting.completionPointsThreshold) {
                milestone = orgSetting.completionPointsThreshold;
            }
        } catch (setErr) {
            console.error('Error fetching settings, using 250 default:', setErr);
        }

        // 2. Fetch Workshops to build a fast name -> zone map
        const workshops = await Workshop.find({ organizationId }).select('name zone pointsReward');
        const workshopZoneMap = {};
        workshops.forEach(w => {
            if (w.name) {
                workshopZoneMap[w.name.trim().toLowerCase()] = w.zone || detectZone(w.name);
            }
        });

        // 3. Filter Students (Admin sees all org students, Staff sees assigned students)
        let studentFilter = { organizationId };
        if (req.user.role === 'staff') {
            studentFilter.assignedStaff = req.user._id;
        }

        const students = await Student.find(studentFilter)
            .populate('assignedStaff', 'name email')
            .sort({ createdAt: -1 });

        // 4. Also fetch raw Attendance collection records for exact cross-sync if needed
        const allAttendances = await Attendance.find({ organizationId })
            .select('studentId workshopId pointsAwarded date')
            .lean();

        // Index attendances by studentId string
        const attendanceByStudent = {};
        allAttendances.forEach(att => {
            const sIdStr = att.studentId?.toString();
            if (!attendanceByStudent[sIdStr]) {
                attendanceByStudent[sIdStr] = [];
            }
            attendanceByStudent[sIdStr].push(att);
        });

        // 5. Aggregate calculations for each student
        const studentSummaries = [];
        const zoneAccumulators = {};
        RIDSS_ZONES.forEach(z => { zoneAccumulators[z] = 0; });

        let totalStudentsCompleted = 0;
        let totalStudentsInProgress = 0;
        let cumulativePointsAll = 0;

        for (const student of students) {
            // Initialize 8 zones with 0
            const zones = {};
            RIDSS_ZONES.forEach(z => { zones[z] = 0; });

            // We combine points from student.attendance embedded array or Attendance collection
            const rawRecords = student.attendance && student.attendance.length > 0
                ? student.attendance
                : (attendanceByStudent[student._id.toString()] || []);

            let calculatedTotal = 0;

            rawRecords.forEach(rec => {
                const wName = rec.workshopName || rec.workshopId || '';
                const cleanWName = wName.trim().toLowerCase();
                const matchedZone = workshopZoneMap[cleanWName] || detectZone(wName);
                const points = Number(rec.pointsEarned || rec.pointsAwarded) || 1;

                zones[matchedZone] = (zones[matchedZone] || 0) + points;
                calculatedTotal += points;
            });

            // If student has existing `points` stored that exceeds calculatedTotal (e.g. initial seed),
            // balance it cleanly across primary zones or preserve total so points never decrease
            const effectiveTotal = Math.max(student.points || 0, calculatedTotal);
            if (effectiveTotal > calculatedTotal) {
                const diff = effectiveTotal - calculatedTotal;
                zones['Social'] += diff; // place legacy untagged diff into Social
            }

            // Milestone and Progress calculations
            const pointsNeeded = Math.max(0, milestone - effectiveTotal);
            const progressPercentage = Math.min(100, Math.round((effectiveTotal / milestone) * 100));

            if (effectiveTotal >= milestone) {
                totalStudentsCompleted++;
            } else {
                totalStudentsInProgress++;
            }

            cumulativePointsAll += effectiveTotal;

            // Add to org-wide zone accumulators
            RIDSS_ZONES.forEach(z => {
                zoneAccumulators[z] += (zones[z] || 0);
            });

            studentSummaries.push({
                _id: student._id,
                studentId: student.studentId,
                name: student.name,
                email: student.email,
                phone: student.phone,
                status: student.status,
                startDate: student.startDate,
                assignedStaff: student.assignedStaff ? {
                    _id: student.assignedStaff._id,
                    name: student.assignedStaff.name,
                    email: student.assignedStaff.email
                } : null,
                zones,
                totalPoints: effectiveTotal,
                pointsNeeded,
                progressPercentage,
                milestone,
                attendanceCount: rawRecords.length
            });
        }

        const totalStudents = studentSummaries.length;
        const averagePoints = totalStudents > 0 ? Math.round(cumulativePointsAll / totalStudents) : 0;

        return res.status(200).json({
            success: true,
            data: {
                milestone,
                metrics: {
                    totalStudents,
                    studentsCompleted: totalStudentsCompleted,
                    studentsInProgress: totalStudentsInProgress,
                    averagePoints,
                    cumulativePointsAll,
                    zoneDistribution: zoneAccumulators
                },
                zones: RIDSS_ZONES,
                students: studentSummaries
            }
        });
    } catch (error) {
        console.error('Error generating RIDSS Point Dashboard:', error);
        return res.status(500).json({
            success: false,
            message: 'Server Error generating RIDSS Point Dashboard',
            error: error.message
        });
    }
};

/**
 * @desc    Get Individual Student RIDSS Point Breakdown
 * @route   GET /api/ridss/student/:id
 * @access  Private/Admin/Staff
 */
const getStudentRidssDetail = async (req, res) => {
    try {
        const { id } = req.params;
        const organizationId = req.user.organizationId;

        const student = await Student.findOne({ _id: id, organizationId })
            .populate('assignedStaff', 'name email');

        if (!student) {
            return res.status(404).json({ success: false, message: 'Student not found' });
        }

        // Check staff authorization
        if (req.user.role === 'staff' && student.assignedStaff && student.assignedStaff._id.toString() !== req.user._id.toString()) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this student' });
        }

        // Fetch milestone
        let milestone = 250;
        try {
            const orgSetting = await Setting.findOne({ organizationId });
            if (orgSetting && orgSetting.completionPointsThreshold) {
                milestone = orgSetting.completionPointsThreshold;
            }
        } catch (e) {
            console.error('Error fetching setting for student detail:', e);
        }

        // Workshops lookup
        const workshops = await Workshop.find({ organizationId }).select('name zone pointsReward');
        const workshopZoneMap = {};
        workshops.forEach(w => {
            if (w.name) {
                workshopZoneMap[w.name.trim().toLowerCase()] = w.zone || detectZone(w.name);
            }
        });

        // Initialize zones data structure with empty arrays
        const zoneBreakdown = {};
        RIDSS_ZONES.forEach(z => {
            zoneBreakdown[z] = {
                zone: z,
                points: 0,
                activities: []
            };
        });

        // Attendance records
        const records = student.attendance && student.attendance.length > 0
            ? student.attendance
            : await Attendance.find({ studentId: student._id }).sort({ date: -1 });

        let calculatedPoints = 0;

        records.forEach(rec => {
            const wName = rec.workshopName || rec.workshopId || '';
            const cleanWName = wName.trim().toLowerCase();
            const matchedZone = workshopZoneMap[cleanWName] || detectZone(wName);
            const points = Number(rec.pointsEarned || rec.pointsAwarded) || 1;
            const dateStr = rec.date instanceof Date ? rec.date.toISOString().split('T')[0] : (rec.date || '');

            zoneBreakdown[matchedZone].points += points;
            zoneBreakdown[matchedZone].activities.push({
                workshopName: wName,
                pointsEarned: points,
                date: dateStr
            });

            calculatedPoints += points;
        });

        const effectiveTotal = Math.max(student.points || 0, calculatedPoints);
        if (effectiveTotal > calculatedPoints) {
            const diff = effectiveTotal - calculatedPoints;
            zoneBreakdown['Social'].points += diff;
            zoneBreakdown['Social'].activities.push({
                workshopName: 'Prior Baseline Points',
                pointsEarned: diff,
                date: 'Recorded Baseline'
            });
        }

        const pointsNeeded = Math.max(0, milestone - effectiveTotal);
        const progressPercentage = Math.min(100, Math.round((effectiveTotal / milestone) * 100));

        // Format zone array with % contribution
        const zonesArray = RIDSS_ZONES.map(z => ({
            zone: z,
            points: zoneBreakdown[z].points,
            percentageOfMilestone: Math.min(100, Math.round((zoneBreakdown[z].points / milestone) * 100)),
            activities: zoneBreakdown[z].activities
        }));

        return res.status(200).json({
            success: true,
            data: {
                student: {
                    _id: student._id,
                    studentId: student.studentId,
                    name: student.name,
                    email: student.email,
                    phone: student.phone,
                    status: student.status,
                    startDate: student.startDate,
                    assignedStaff: student.assignedStaff ? {
                        _id: student.assignedStaff._id,
                        name: student.assignedStaff.name,
                        email: student.assignedStaff.email
                    } : null
                },
                milestone,
                totalPoints: effectiveTotal,
                pointsNeeded,
                progressPercentage,
                zones: zonesArray
            }
        });
    } catch (error) {
        console.error('Error fetching student RIDSS detail:', error);
        return res.status(500).json({
            success: false,
            message: 'Server Error fetching student RIDSS detail',
            error: error.message
        });
    }
};

module.exports = {
    getRidssZones,
    getRidssDashboard,
    getStudentRidssDetail,
    RIDSS_ZONES,
    detectZone
};

