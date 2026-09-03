import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getAuth, Auth } from 'firebase-admin/auth';

@Injectable()
export class FirebaseAdminProvider {
  private readonly app: App;

  constructor(private readonly config: ConfigService) {
    if (getApps().length) {
      this.app = getApps()[0];
      return;
    }

    this.app = initializeApp({
      credential: cert({
        projectId: this.config.get<string>('FIREBASE_PROJECT_ID'),
        clientEmail: this.config.get<string>('FIREBASE_CLIENT_EMAIL'),
        privateKey: this.config
          .get<string>('FIREBASE_PRIVATE_KEY')
          ?.replace(/\\n/g, '\n'),
      }),
    });
  }

  get auth(): Auth {
    return getAuth(this.app);
  }
}
