/**
 * Create a platform admin panel user (there is no public sign-up for the panel).
 * The first one should be a superadmin; more can then be added from the panel.
 *
 * Usage (leave .env on dev — pass the database for this command only):
 *   PLATFORM_ADMIN_PASSWORD='…' node scripts/create-platform-admin.mjs --email you@example.com --name "Ahmed" [--role superadmin|support]
 *   MONGODB_URI='mongodb+srv://…/pos-production…' PLATFORM_ADMIN_PASSWORD='…' node scripts/create-platform-admin.mjs --email … --name …
 *
 * The password is read from PLATFORM_ADMIN_PASSWORD (not a CLI flag) so it
 * doesn't end up in shell history or process lists.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import PlatformAdmin from '../models/platformAdmin.mjs';

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async () => {
    const email = String(arg('email') || '').trim().toLowerCase();
    const name = String(arg('name') || '').trim();
    const role = arg('role') || 'superadmin';
    const password = process.env.PLATFORM_ADMIN_PASSWORD || '';

    if (!email || !name) throw new Error('--email and --name are required');
    if (!['superadmin', 'support'].includes(role)) throw new Error('--role must be superadmin or support');
    if (password.length < 8) throw new Error('Set PLATFORM_ADMIN_PASSWORD (at least 8 characters)');

    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`Database: ${mongoose.connection.db.databaseName}`);
    if (await PlatformAdmin.exists({ email })) throw new Error(`A panel user with ${email} already exists`);

    const admin = await PlatformAdmin.create({ name, email, role, password: await bcrypt.hash(password, 10) });
    console.log(`Created ${role} ${admin.email} (${admin._id})`);
};

main()
    .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
