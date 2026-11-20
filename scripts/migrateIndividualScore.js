const mongoose = require('mongoose');
require('dotenv').config();

const migrate = async () => {
    try {
        if (!process.env.MONGO_URI) {
            console.error('MONGO_URI not found in environment variables');
            process.exit(1);
        }

        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const collection = mongoose.connection.collection('monthlysnapshots');

        const snapshots = await collection.find({
            'participantSnapshots.individualScore': { $type: 'number' }
        }).toArray();

        console.log(`Found ${snapshots.length} snapshots with numeric individualScore`);

        for (const snapshot of snapshots) {
            const updatedParticipants = snapshot.participantSnapshots.map(participant => {
                if (typeof participant.individualScore === 'number') {
                    return {
                        ...participant,
                        individualScore: {
                            score: participant.individualScore,
                            applicableCount: participant.applicableCount || 7,
                            scorePercentage: participant.scorePercentage || 0,
                            statusColor: participant.statusColor || 'Green',
                            isEvaluated: false,
                            evaluatedAt: null,
                            responses: []
                        }
                    };
                }
                return participant;
            });

            await collection.updateOne(
                { _id: snapshot._id },
                { $set: { participantSnapshots: updatedParticipants } }
            );

            console.log(`Migrated snapshot: ${snapshot._id} (month: ${snapshot.month})`);
        }

        console.log('Migration completed successfully');
        await mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error.message);
        process.exit(1);
    }
};

migrate();
