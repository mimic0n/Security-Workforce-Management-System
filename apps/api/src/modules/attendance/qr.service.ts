import { Injectable } from "@nestjs/common";
import { DEFAULT_QR_SECRET, generateQrToken } from "@swms/contracts";

@Injectable()
export class QrService {
  private readonly secret: string;

  constructor() {
    this.secret = process.env.QR_HMAC_SECRET || DEFAULT_QR_SECRET;
  }

  public generateToken(qrCodeId: string): string {
    return generateQrToken(qrCodeId, this.secret);
  }

  public verifyToken(qrCodeId: string, token: string): boolean {
    if (!qrCodeId || !token) return false;
    const expected = this.generateToken(qrCodeId);
    return token.trim().toLowerCase() === expected.trim().toLowerCase();
  }
}
