import * as dotenv from 'dotenv';
import * as path from 'path';

// TEST_ENV_FILE=.env runs the suites against the real config instead of .env.test.
dotenv.config({ path: path.resolve(__dirname, '..', process.env.TEST_ENV_FILE ?? '.env.test') });
