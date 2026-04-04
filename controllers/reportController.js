import PDFDocument from 'pdfkit';
import { sendEmail } from '../utils/emailService.js';
import Expense from '../models/expenseModel.js';
import User from '../models/userModel.js';
import fs from 'fs';
import path from 'path';

// --- Constants & Styles ---

const COLORS = {
    primary: '#111827',   // Slate 900
    secondary: '#6B7280', // Gray 500
    accent: '#4F46E5',    // Indigo 600
    income: '#059669',    // Emerald 600
    incomeBG: '#ECFDF5',  // Emerald 50
    expense: '#DC2626',   // Red 600
    expenseBG: '#FEF2F2', // Red 50
    balance: '#2563EB',   // Blue 600
    balanceBG: '#EFF6FF', // Blue 50
    border: '#E5E7EB',    // Gray 200
    white: '#FFFFFF',
    bg: '#F9FAFB',        // Gray 50
    chartGrid: '#F3F4F6'  // Gray 100
};

const CATEGORY_STYLES = {
    'Income': { bg: '#D1FAE5', text: '#065F46', chart: '#10B981' }, // Emerald 500
    'Groceries': { bg: '#ECFCCB', text: '#365314', chart: '#84CC16' }, // Lime 500
    'Healthcare': { bg: '#FEE2E2', text: '#991B1B', chart: '#EF4444' }, // Red 500
    'Food & Dining': { bg: '#DBEAFE', text: '#1E40AF', chart: '#3B82F6' }, // Blue 500
    'Bills & Utilities': { bg: '#FEF3C7', text: '#92400E', chart: '#F59E0B' }, // Amber 500
    'Entertainment': { bg: '#F3E8FF', text: '#6B21A8', chart: '#A855F7' }, // Purple 500
    'Transport': { bg: '#E0E7FF', text: '#3730A3', chart: '#6366F1' }, // Indigo 500
    'Education': { bg: '#FFEDD5', text: '#9A3412', chart: '#F97316' }, // Orange 500
    'Shopping': { bg: '#FCE7F3', text: '#9D174D', chart: '#EC4899' }, // Pink 500
    'Other': { bg: '#F3F4F6', text: '#374151', chart: '#9CA3AF' },  // Gray 400
    'Added by Admin': { bg: '#EFF6FF', text: '#1E40AF', chart: '#3B82F6' } // Blue 500 (similar to Food & Dining but unique for Admin)
};

const LOGO_PATH = path.join(process.cwd(), 'assets', 'logo.jpg');

const CURRENCY = {
    locale: 'en-IN',
    code: 'INR',
    symbol: '₹'
};

export const formatCurrency = (amount) => {
    return new Intl.NumberFormat(CURRENCY.locale, {
        style: 'currency',
        currency: CURRENCY.code,
        minimumFractionDigits: 2
    }).format(amount);
};

const FONT_PATH = path.join(process.cwd(), 'assets', 'fonts');

const FONTS = {
    regular: path.join(FONT_PATH, 'Inter-Regular.ttf'),
    bold: path.join(FONT_PATH, 'Inter-Bold.ttf')
};

// --- Helper Functions (Exported for Testing) ---

export const drawRoundedRect = (doc, x, y, width, height, radius, fill, stroke) => {
    doc.save();
    if (fill) doc.fillColor(fill).roundedRect(x, y, width, height, radius).fill();
    if (stroke) doc.strokeColor(stroke).lineWidth(1).roundedRect(x, y, width, height, radius).stroke();
    doc.restore();
};

export const drawPill = (doc, x, y, text, style) => {
    const paddingH = 8;
    const paddingV = 4;
    doc.font('Regular').fontSize(8);
    const textWidth = doc.widthOfString(text);
    const width = textWidth + (paddingH * 2);
    const height = 16;

    drawRoundedRect(doc, x, y - 10, width, height, 8, style.bg);
    doc.fillColor(style.text).text(text, x + paddingH, y - 6);
    return width;
};

export const drawHeader = (doc, user, start, end) => {
    const logoX = 50;
    const logoY = 40;

    // Logo PNG Integration
    if (fs.existsSync(LOGO_PATH)) {
        try {
            doc.image(LOGO_PATH, logoX, logoY, { height: 40 });
        } catch (err) {
            console.error('Error drawing logo image:', err);
            // Fallback
            drawRoundedRect(doc, logoX, logoY, 40, 40, 8, '#84CC16');
            doc.fillColor(COLORS.white).font('Bold').fontSize(20).text('EG', logoX + 6, logoY + 12);
        }
    } else {
        // Fallback Green Square Logo
        drawRoundedRect(doc, logoX, logoY, 40, 40, 8, '#84CC16');
        doc.fillColor(COLORS.white).font('Bold').fontSize(20).text('EG', logoX + 6, logoY + 12);
    }

    doc.fillColor(COLORS.secondary).font('Regular').fontSize(8).text('REPORT PERIOD', 400, 45, { align: 'right', width: 150 });
    doc.fillColor(COLORS.primary).font('Bold').fontSize(11).text(`${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`, 400, 58, { align: 'right', width: 150 });

    doc.fillColor(COLORS.primary).font('Bold').fontSize(28).text('Expense Analysis', 50, 100);
    doc.fillColor(COLORS.secondary).font('Regular').fontSize(11).text('Prepared for: ', 50, 135, { continued: true });
    doc.fillColor(COLORS.primary).font('Bold').text(user.name);

    doc.moveTo(50, 165).lineTo(550, 165).strokeColor(COLORS.border).lineWidth(0.5).stroke();
};

export const drawSummaryCards = (doc, income, expense, balance) => {
    const y = 185;
    const cardWidth = 155;
    const height = 80;
    const gap = 15;

    drawRoundedRect(doc, 50, y, cardWidth, height, 10, COLORS.white, COLORS.border);
    doc.fillColor(COLORS.secondary).fontSize(8).font('Bold').text('TOTAL EXPENSES', 75, y + 20);
    doc.fillColor(COLORS.primary).fontSize(20).font('Bold').text(formatCurrency(expense), 75, y + 38);

    drawRoundedRect(doc, 50 + cardWidth + gap, y, cardWidth, height, 10, COLORS.white, COLORS.border);
    doc.fillColor(COLORS.secondary).fontSize(8).font('Bold').text('TOTAL INCOME', 50 + cardWidth + gap + 25, y + 20);
    doc.fillColor(COLORS.balance).fontSize(20).font('Bold').text(formatCurrency(income), 50 + cardWidth + gap + 25, y + 38);

    drawRoundedRect(doc, 50 + (cardWidth + gap) * 2, y, cardWidth, height, 10, COLORS.white, COLORS.border);
    doc.fillColor(COLORS.secondary).fontSize(8).font('Bold').text('NET BALANCE', 50 + (cardWidth + gap) * 2 + 25, y + 20);
    const balanceColor = balance >= 0 ? COLORS.income : COLORS.expense;
    const balancePrefix = balance >= 0 ? '+' : '';
    doc.fillColor(balanceColor).fontSize(20).font('Bold').text(`${balancePrefix}${formatCurrency(balance)}`, 50 + (cardWidth + gap) * 2 + 25, y + 38);
};

export const drawSpendingTrend = (doc, expenses, x, y, width, height, reportType) => {
    // Dynamic Grouping
    const groupedData = {};
    const debits = expenses.filter(e => e.type === 'debit');

    if (debits.length === 0) return false;

    // Pre-populate based on report type
    let labels = [];
    if (reportType === 'yearly') {
        labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    } else if (reportType === 'monthly') {
        labels = ['W1', 'W2', 'W3', 'W4', 'W5'];
    } else {
        // Daily (last 7 days logic usually, but let's be flexible)
        const days = [...new Set(debits.map(e => new Date(e.date).getDate()))].sort((a, b) => a - b);
        labels = days.map(d => d.toString());
    }

    labels.forEach(l => groupedData[l] = 0);

    debits.forEach(e => {
        const date = new Date(e.date);
        let key;
        if (reportType === 'yearly') {
            key = date.toLocaleString('default', { month: 'short' });
        } else if (reportType === 'monthly') {
            const weekNum = Math.ceil(date.getDate() / 7);
            key = `W${weekNum}`;
        } else {
            key = date.getDate().toString();
        }
        if (groupedData.hasOwnProperty(key)) {
            groupedData[key] += e.amount;
        }
    });

    doc.fillColor(COLORS.primary).font('Bold').fontSize(12).text('Spending Trend', x, y);
    doc.fillColor(COLORS.secondary).font('Regular').fontSize(8).text(reportType === 'yearly' ? 'Monthly summary over year' : reportType === 'monthly' ? 'Weekly summary over month' : 'Daily expenses over week', x, y + 15);

    const chartY = y + 40;
    const chartHeight = height - 40;
    drawRoundedRect(doc, x, chartY, width, chartHeight, 10, COLORS.white, COLORS.border);

    const values = labels.map(l => groupedData[l]);
    const maxVal = Math.max(...values, 10);
    const stepX = (width - 40) / (labels.length > 1 ? labels.length - 1 : 1);

    doc.save();
    doc.translate(x + 20, chartY + chartHeight - 20);

    const points = labels.map((l, i) => ({
        x: i * stepX,
        y: -(groupedData[l] / maxVal) * (chartHeight - 60)
    }));

    // Area
    doc.moveTo(0, 0);
    points.forEach((p, i) => {
        if (i === 0) doc.moveTo(p.x, 0).lineTo(p.x, p.y);
        else doc.lineTo(p.x, p.y);
    });
    doc.lineTo(points[points.length - 1].x, 0);
    doc.closePath();
    doc.fillColor(COLORS.balanceBG).fill();

    // Line
    doc.moveTo(points[0].x, points[0].y);
    points.forEach(p => doc.lineTo(p.x, p.y));
    doc.strokeColor(COLORS.balance).lineWidth(1.5).stroke();

    // Labels
    doc.font('Regular').fontSize(7).fillColor(COLORS.secondary);
    labels.forEach((l, i) => {
        if (labels.length > 12 && i % 2 !== 0) return; // Sparse labels for large data
        doc.text(l, i * stepX - 10, 5, { width: 20, align: 'center' });
    });

    doc.restore();
    return true;
};

export const drawCategoryBreakdown = (doc, categoryData, x, y, width, height) => {
    doc.fillColor(COLORS.primary).font('Bold').fontSize(12).text('Category Breakdown', x, y);
    doc.fillColor(COLORS.secondary).font('Regular').fontSize(8).text('Where your money went', x, y + 15);

    const radius = 55;
    const centerX = x + 65;
    const centerY = y + 90;
    const innerRadius = 42;

    const total = Object.values(categoryData).reduce((a, b) => a + b, 0);
    if (total === 0) return false;

    let startAngle = 0;
    const sortedCats = Object.entries(categoryData).sort((a, b) => b[1] - a[1]);

    sortedCats.forEach(([cat, amount], i) => {
        const sliceAngle = (amount / total) * 2 * Math.PI;
        const endAngle = startAngle + sliceAngle;

        const x1 = centerX + radius * Math.cos(startAngle);
        const y1 = centerY + radius * Math.sin(startAngle);
        const x2 = centerX + radius * Math.cos(endAngle);
        const y2 = centerY + radius * Math.sin(endAngle);

        const largeArcFlag = sliceAngle > Math.PI ? 1 : 0;
        const style = CATEGORY_STYLES[cat] || CATEGORY_STYLES['Other'];

        doc.save()
            .path(`M ${centerX} ${centerY} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2} Z`)
            .fill(style.chart);

        startAngle = endAngle;
    });

    doc.circle(centerX, centerY, innerRadius).fill(COLORS.white);

    // Legend
    let legendY = y + 45;
    sortedCats.forEach(([cat, amount], i) => {
        const percentage = Math.round((amount / total) * 100);
        const style = CATEGORY_STYLES[cat] || CATEGORY_STYLES['Other'];
        doc.circle(x + 145, legendY + 5, 3.5).fill(style.chart);
        doc.fillColor(COLORS.primary).font('Regular').fontSize(8.5).text(cat, x + 158, legendY);
        doc.fillColor(COLORS.secondary).text(`${percentage}%`, x + 230, legendY, { align: 'right', width: 25 });
        legendY += 18;
    });
    return true;
};

export const drawTransactionTable = (doc, expenses, startY) => {
    doc.fillColor(COLORS.primary).font('Bold').fontSize(14).text('Transaction History', 50, startY + 10);
    let y = startY + 40;

    drawRoundedRect(doc, 50, y, 500, 30, 5, COLORS.bg);
    doc.fillColor(COLORS.secondary).font('Bold').fontSize(9);
    doc.text('Date', 70, y + 10);
    doc.text('Description', 160, y + 10);
    doc.text('Category', 340, y + 10);
    doc.text('Amount', 480, y + 10, { width: 50, align: 'right' });

    y += 40;
    expenses.forEach((exp) => {
        if (y > 740) {
            doc.addPage();
            // Redraw Header for next page
            drawRoundedRect(doc, 50, 50, 500, 30, 5, COLORS.bg);
            doc.fillColor(COLORS.secondary).font('Bold').fontSize(9);
            doc.text('Date', 70, 60);
            doc.text('Description', 160, 60);
            doc.text('Category', 340, 60);
            doc.text('Amount', 480, 60, { width: 50, align: 'right' });
            y = 90;
        }
        const isIncome = exp.type === 'credit' || exp.type === 'assign';
        const color = isIncome ? COLORS.income : COLORS.primary;
        const prefix = isIncome ? '+' : '-';
        const catStyle = CATEGORY_STYLES[exp.category] || CATEGORY_STYLES['Other'];

        doc.fillColor(COLORS.secondary).font('Regular').fontSize(8.5).text(new Date(exp.date).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }), 70, y);
        doc.fillColor(COLORS.primary).font('Bold').fontSize(8.5).text(exp.details.substring(0, 32), 160, y);
        drawPill(doc, 340, y + 5, exp.category || 'Other', catStyle);
        doc.fillColor(color).font('Bold').fontSize(8.5).text(`${prefix}${formatCurrency(exp.amount)}`, 450, y, { width: 80, align: 'right' });
        doc.moveTo(50, y + 20).lineTo(550, y + 20).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        y += 35;
    });
};

export const drawFooter = (doc, currentPage, totalPages) => {
    const y = 775; // Stay within 791.89 threshold (841.89 - 50 margin)
    doc.save();
    doc.moveTo(50, y - 5).lineTo(550, y - 5).strokeColor(COLORS.border).lineWidth(0.5).stroke();
    doc.fillColor(COLORS.secondary).font('Regular').fontSize(8).text(`Generated on ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`, 50, y);
    doc.text(`Page ${currentPage} of ${totalPages}`, 500, y, { align: 'right' });
    doc.restore();
};

export const addFooters = (doc) => {
    const range = doc.bufferedPageRange();
    for (let i = range.start, end = range.start + range.count, rangeCount = range.count; i < end; i++) {
        doc.switchToPage(i);
        drawFooter(doc, i + 1, rangeCount);
    }
};

// --- Main Controller ---

export const generateReport = async (req, res) => {
    try {
        const requesterId = req.userId;
        const { type, targetUserId, startDate, endDate } = req.body || {};
        if (!requesterId) return res.sendStatus(401);
        if (!startDate || !endDate) {
            return res.status(400).json({
                error: "startDate and endDate are required"
            });
        }
        const requester = await User.findById(requesterId);
        if (!requester || !requester.email) return res.status(400).send("Requester email not found");

        const start = new Date(startDate);
        const end = new Date(endDate);

        if (isNaN(start) || isNaN(end)) {
            return res.status(400).json({ error: "Invalid date format" });
        }

        // Determine whose report we are generating
        let userIdToReport = requesterId;
        let isAdminReport = false;

        if (requester.role === 'admin' && targetUserId) {
            userIdToReport = targetUserId;
            isAdminReport = true;
        }

        const reportUser = await User.findById(userIdToReport);
        if (!reportUser) return res.status(404).send("Target user not found");

        const expenses = await Expense.find({
            userId: userIdToReport,
            date: { $gte: start, $lte: end }
        }).sort({ date: -1 });

        const income = expenses.filter(e => e.type === 'credit' || e.type === 'assign').reduce((sum, e) => sum + e.amount, 0);
        const expenseTotal = expenses.filter(e => e.type === 'debit').reduce((sum, e) => sum + e.amount, 0);
        const savings = income - expenseTotal;

        const categoryData = {};
        expenses.filter(e => e.type === 'debit').forEach(e => {
            const cat = e.category || 'Other';
            categoryData[cat] = (categoryData[cat] || 0) + e.amount;
        });

        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
        let buffers = [];
        doc.registerFont('Regular', FONTS.regular);
        doc.registerFont('Bold', FONTS.bold);
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', async () => {
            const pdfData = Buffer.concat(buffers);
            try {
                const subject = isAdminReport
                    ? `Expense Analysis Report for ${reportUser.name}`
                    : `Your Expense Analysis Report - ${start.toLocaleDateString()} to ${end.toLocaleDateString()}`;

                const emailText = isAdminReport
                    ? `Attached is the detailed expense analysis report for ${reportUser.name} (${reportUser.email}), as you requested.`
                    : `Attached is your detailed expense analysis report.`;


                const mailResponse = await sendEmail({
                    to: requester.email,
                    subject: subject,
                    text: emailText,
                    attachments: [{ filename: `Expense_Analysis_${reportUser.name}_${type || 'Report'}.pdf`, content: pdfData }]
                });
                res.status(200).send({ message: "Report sent" });
            } catch (error) {
                console.error("Email error:", error);
                res.status(500).send("Failed to send email");
            }
        });

        drawHeader(doc, reportUser, start, end);
        drawSummaryCards(doc, income, expenseTotal, savings);

        let tableStartY = 285;
        if (expenseTotal > 0) {
            drawSpendingTrend(doc, expenses, 50, 285, 250, 180, type);
            drawCategoryBreakdown(doc, categoryData, 320, 285, 230, 180);
            tableStartY = 490;
        }

        drawTransactionTable(doc, expenses, tableStartY);

        // Final pass to add footers to all pages
        addFooters(doc);

        doc.end();

    } catch (error) {
        console.error("Report generation error:", error);
        res.status(500).send("Error generating report");
    }
};
