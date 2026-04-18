import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Admin from './models/admin.mjs';
import Bill from './models/bill.mjs';
import BusinessType from './models/businessType.mjs';
import Business from './models/business.mjs';
import Employee from './models/employee.mjs';
import Product from './models/product.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const privateKey = fs.readFileSync(path.resolve(__dirname, './private.key'), 'utf-8');

const uri = process.env.MONGODB_URI;

const seedData = async () => {
    try {
        await mongoose.connect(uri);
        console.log('Database Connected');

        // Clear existing data
        await Admin.deleteMany({});
        await Bill.deleteMany({});
        await BusinessType.deleteMany({});
        await Business.deleteMany({});
        await Employee.deleteMany({});
        await Product.deleteMany({});
        console.log('Cleared existing data');

        // Create Business Type (Retail only for inventory)
        const businessTypes = [
            {
                name: 'Retail Store',
                code: 'retail',
                icon: 'storefront',
                description: 'Shop, supermarket, or retail business',
                features: ['Inventory tracking', 'Barcode scanning', 'Stock alerts', 'Product variants', 'Returns'],
                sortOrder: 1,
                isActive: true
            }
        ];

        const createdTypes = await BusinessType.insertMany(businessTypes);
        console.log('Business types created:', createdTypes.length, 'types');

        // Create a default business (Retail type)
        const retailType = createdTypes.find(t => t.code === 'retail');
        const defaultBusiness = await Business.create({
            name: 'Demo Store',
            businessType: retailType._id,
            email: 'demo@store.com',
            phone: '+92-300-1234567',
            address: {
                street: '123 Main Street',
                city: 'Karachi',
                state: 'Sindh',
                zipCode: '75500',
                country: 'Pakistan'
            },
            currency: 'PKR',
            taxRate: 10,
            taxLabel: 'GST'
        });
        console.log('Default business created:', defaultBusiness.name);

        // Create Admin (linked to default business)
        const adminPassword = bcrypt.hashSync('admin123', 10);
        const adminToken = jwt.sign({ email: 'admin@pos.com' }, privateKey, { algorithm: 'RS256' });

        const admin = await Admin.create({
            name: 'Admin User',
            email: 'admin@pos.com',
            password: adminPassword,
            token: adminToken,
            business: defaultBusiness._id,
            role: 'owner'
        });
        console.log('Admin created:', admin.email, '(linked to', defaultBusiness.name + ')');


        // Create Sample Products
        const products = [
            { name: 'Coca Cola 330ml', barcode: '8901234567890', sku: 'BEV-001', costPrice: 30, sellingPrice: 50, gst: 5, category: 'Beverages', stockQuantity: 100, lowStockAlert: 20, trackStock: true, business: defaultBusiness._id },
            { name: 'Lays Classic Chips', barcode: '8901234567891', sku: 'SNK-001', costPrice: 20, sellingPrice: 40, gst: 5, category: 'Snacks', stockQuantity: 80, lowStockAlert: 15, trackStock: true, business: defaultBusiness._id },
            { name: 'Fresh Milk 1L', barcode: '8901234567892', sku: 'DAI-001', costPrice: 80, sellingPrice: 120, gst: 0, category: 'Dairy', stockQuantity: 50, lowStockAlert: 10, trackStock: true, business: defaultBusiness._id },
            { name: 'White Bread', barcode: '8901234567893', sku: 'BAK-001', costPrice: 40, sellingPrice: 70, gst: 0, category: 'Bakery', stockQuantity: 30, lowStockAlert: 5, trackStock: true, business: defaultBusiness._id },
            { name: 'Basmati Rice 5kg', barcode: '8901234567894', sku: 'GRO-001', costPrice: 400, sellingPrice: 550, gst: 5, category: 'Grocery', stockQuantity: 40, lowStockAlert: 10, trackStock: true, business: defaultBusiness._id },
            { name: 'Cooking Oil 1L', barcode: '8901234567895', sku: 'GRO-002', costPrice: 200, sellingPrice: 280, gst: 5, category: 'Grocery', stockQuantity: 60, lowStockAlert: 15, trackStock: true, business: defaultBusiness._id },
            { name: 'Eggs (12 pack)', barcode: '8901234567896', sku: 'DAI-002', costPrice: 150, sellingPrice: 200, gst: 0, category: 'Dairy', stockQuantity: 25, lowStockAlert: 5, trackStock: true, business: defaultBusiness._id },
            { name: 'Sugar 1kg', barcode: '8901234567897', sku: 'GRO-003', costPrice: 80, sellingPrice: 110, gst: 0, category: 'Grocery', stockQuantity: 45, lowStockAlert: 10, trackStock: true, business: defaultBusiness._id },
        ];

        await Product.insertMany(products);
        console.log('Products created:', products.length, 'products');

        // Create Sample Receipts
        const receipts = [
            {
                billNumber: 1001,
                items: [
                    { category: 'Beverages', description: 'Coca Cola 330ml', gst: 5, name: 'Coca Cola 330ml', price: 50, qty: 2 },
                    { category: 'Snacks', description: 'Lays Classic Chips', gst: 5, name: 'Lays Classic Chips', price: 40, qty: 1 }
                ],
                cashierName: 'John Cashier',
                customerName: 'Walk-in Customer',
                date: '2024-12-28',
                time: '12:30 PM',
                totalBill: 140,
                totalGST: 7,
                totalQty: 3,
                cashGiven: 200,
                receiptType: 'retail_sale',
                business: defaultBusiness._id
            },
            {
                billNumber: 1002,
                items: [
                    { category: 'Grocery', description: 'Basmati Rice 5kg', gst: 5, name: 'Basmati Rice 5kg', price: 550, qty: 1 },
                    { category: 'Dairy', description: 'Fresh Milk 1L', gst: 0, name: 'Fresh Milk 1L', price: 120, qty: 2 }
                ],
                cashierName: 'Jane Cashier',
                customerName: 'Ahmed Khan',
                date: '2024-12-28',
                time: '01:15 PM',
                totalBill: 790,
                totalGST: 28,
                totalQty: 3,
                cashGiven: 800,
                receiptType: 'retail_sale',
                business: defaultBusiness._id
            },
        ];

        for (const r of receipts) {
            const bill = new Bill({
                ...r,
                status: 'completed',
                type: 'sale',
                payments: [{ amount: r.cashGiven, method: 'cash' }]
            });
            await bill.save();
        }
        console.log('Sample bills created:', receipts.length, 'bills');

        console.log('\n========================================');
        console.log('SEED DATA CREATED SUCCESSFULLY!');
        console.log('========================================');
        console.log('\nLogin Credentials:');
        console.log('------------------');
        console.log('ADMIN:');
        console.log('  Email: admin@pos.com');
        console.log('  Password: admin123');
        console.log('\nPRODUCTS: 8 retail products added');
        console.log('  Categories: Beverages, Snacks, Dairy, Bakery, Grocery');
        console.log('========================================\n');

        await mongoose.disconnect();
        console.log('Database disconnected');
        process.exit(0);

    } catch (error) {
        console.error('Error seeding data:', error);
        process.exit(1);
    }
};

seedData();
