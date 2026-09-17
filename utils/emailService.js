import dotenv from 'dotenv';

dotenv.config();

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

export const sendEmail = async ({ to, subject, text, html, attachments }) => {
    if (!process.env.BREVO_API_KEY) {
        throw new Error('BREVO_API_KEY is not defined');
    }

    const payload = {
        sender: {
            name: 'ExpenseGauge',
            email: process.env.ADMIN_EMAIL,
        },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html,
        attachment: attachments?.map(att => ({
            name: att.filename,
            content: Buffer.isBuffer(att.content)
                ? att.content.toString('base64')
                : att.content,
        })),
    };

    try {
        const response = await fetch(BREVO_API_URL, {
            method: 'POST',
            headers: {
                'api-key': process.env.BREVO_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Brevo error response:', data);
            throw new Error(data.message || 'Failed to send email via Brevo');
        }

        return data;
    } catch (error) {
        console.error('Error sending email via Brevo:', error);
        throw error;
    }
};
