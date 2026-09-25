import nodemailer from 'nodemailer';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Email Notification Service
 * Sends notifications about post publishing results
 */

const transporter = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  secure: config.email.port === 465,
  auth: {
    user: config.email.user,
    pass: config.email.pass,
  },
});

export interface PostNotification {
  to: string;
  userName: string;
  pageName: string;
  postCaption: string;
  status: 'success' | 'failed';
  permalink?: string;
  errorMessage?: string;
  publishedAt: Date;
}

/**
 * Send post publishing result notification
 */
export async function sendPostNotification(data: PostNotification): Promise<void> {
  const isSuccess = data.status === 'success';

  const subject = isSuccess
    ? `✅ Bài đăng đã được đăng thành công - ${data.pageName}`
    : `❌ Đăng bài thất bại - ${data.pageName}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { background: ${isSuccess ? 'linear-gradient(135deg, #667eea, #764ba2)' : 'linear-gradient(135deg, #f56565, #e53e3e)'}; padding: 30px; text-align: center; }
        .header h1 { color: white; margin: 0; font-size: 24px; }
        .header p { color: rgba(255,255,255,0.9); margin: 8px 0 0; }
        .content { padding: 30px; }
        .status-badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-weight: 600; font-size: 14px; background: ${isSuccess ? '#c6f6d5' : '#fed7d7'}; color: ${isSuccess ? '#22543d' : '#9b2c2c'}; }
        .info-row { display: flex; padding: 12px 0; border-bottom: 1px solid #eee; }
        .info-label { width: 120px; color: #718096; font-size: 14px; }
        .info-value { flex: 1; color: #2d3748; font-size: 14px; }
        .caption-box { background: #f7fafc; border-left: 4px solid #667eea; padding: 16px; margin: 16px 0; border-radius: 0 8px 8px 0; }
        .caption-box p { margin: 0; color: #4a5568; line-height: 1.6; }
        .btn { display: inline-block; padding: 12px 24px; background: #667eea; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; }
        .footer { padding: 20px 30px; background: #f7fafc; text-align: center; color: #a0aec0; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${isSuccess ? '🎉 Đăng Bài Thành Công!' : '⚠️ Đăng Bài Thất Bại'}</h1>
          <p>${data.pageName}</p>
        </div>
        <div class="content">
          <div style="margin-bottom: 20px;">
            <span class="status-badge">${isSuccess ? '✅ Thành công' : '❌ Thất bại'}</span>
          </div>
          
          <div class="info-row">
            <div class="info-label">Trang:</div>
            <div class="info-value"><strong>${data.pageName}</strong></div>
          </div>
          <div class="info-row">
            <div class="info-label">Thời gian:</div>
            <div class="info-value">${data.publishedAt.toLocaleString('vi-VN')}</div>
          </div>
          
          <h3 style="margin-top: 24px; color: #2d3748;">📝 Nội dung bài đăng:</h3>
          <div class="caption-box">
            <p>${data.postCaption.substring(0, 300)}${data.postCaption.length > 300 ? '...' : ''}</p>
          </div>

          ${data.errorMessage ? `
          <div style="background: #fed7d7; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <strong style="color: #9b2c2c;">Lỗi:</strong>
            <p style="color: #9b2c2c; margin: 8px 0 0;">${data.errorMessage}</p>
          </div>
          ` : ''}

          ${data.permalink ? `
          <div style="text-align: center; margin-top: 24px;">
            <a href="${data.permalink}" class="btn" target="_blank">Xem bài đăng trên Facebook →</a>
          </div>
          ` : ''}
        </div>
        <div class="footer">
          <p>Auto Post Facebook - Hệ thống đăng bài tự động</p>
          <p>© ${new Date().getFullYear()} Auto Post. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await transporter.sendMail({
      from: config.email.from,
      to: data.to,
      subject,
      html,
    });

    logger.info('Notification email sent', { to: data.to, status: data.status });
  } catch (error) {
    logger.error('Failed to send notification email:', error);
    // Don't throw - email failure shouldn't block the pipeline
  }
}

/**
 * Send welcome email after registration
 */
export async function sendWelcomeEmail(to: string, userName: string): Promise<void> {
  try {
    await transporter.sendMail({
      from: config.email.from,
      to,
      subject: '🎉 Chào mừng bạn đến với Auto Post!',
      html: `
        <div style="font-family: 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
          <h1>Xin chào ${userName}! 👋</h1>
          <p>Cảm ơn bạn đã đăng ký Auto Post - hệ thống đăng bài Facebook tự động với AI.</p>
          <p>Hãy bắt đầu bằng cách:</p>
          <ol>
            <li>Kết nối Facebook Page của bạn</li>
            <li>Tạo mẫu nội dung đầu tiên</li>
            <li>Để AI tạo bài đăng cho bạn!</li>
          </ol>
          <p>Chúc bạn thành công! 🚀</p>
        </div>
      `,
    });
  } catch (error) {
    logger.error('Failed to send welcome email:', error);
  }
}
