import {createRequire} from 'node:module';
import {getMigrationStatus} from './migration-runner.mjs';
import {isIdentityProviderAvailable} from './identity-readiness.mjs';

const require = createRequire(import.meta.url);
const packageVersion = require('../package.json').version;

const getBuildMetadata = (environment) => {
  const configuredVersion = String(environment.APP_VERSION || packageVersion || 'unknown');
  const configuredCommit = String(environment.BUILD_SHA || environment.GITHUB_SHA || '');
  return {
    version: /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(configuredVersion) ? configuredVersion : 'unknown',
    commit: /^[0-9a-f]{7,40}$/i.test(configuredCommit) ? configuredCommit.toLowerCase() : 'unknown',
  };
};

const noStore = (response) => response.setHeader('Cache-Control', 'no-store');

export const createHealthHandlers = ({
  pool,
  rootDir,
  environment = process.env,
  migrationStatus = getMigrationStatus,
  identityProviderReady = isIdentityProviderAvailable,
  checkSessionLifetime,
}) => {
  const build = getBuildMetadata(environment);
  const productionRuntime = environment.NODE_ENV === 'production' || environment.APP_MODE === 'production';

  const live = (_request, response) => {
    noStore(response);
    response.status(200).json({status: 'live'});
  };

  const ready = async (_request, response) => {
    noStore(response);
    try {
      await pool.query('select 1');
    } catch {
      response.status(503).json({status: 'unready', database: 'unavailable', migrations: 'unknown'});
      return;
    }

    try {
      const status = await migrationStatus(pool, {rootDir});
      if (!status.isCurrent) {
        response.status(503).json({
          status: 'unready',
          database: 'connected',
          migrations: status.unknownIds.length > 0 ? 'unsupported' : 'pending',
          migrationLevel: status.currentVersion,
          pendingMigrationCount: status.pendingIds.length,
          unsupportedMigrationCount: status.unknownIds.length,
        });
        return;
      }
      if (productionRuntime) {
        try {
          await checkSessionLifetime();
        } catch {
          response.status(503).json({status: 'unready', database: 'connected', migrations: 'current', sessionPolicy: 'unavailable'});
          return;
        }
      }
      let providerReady = false;
      try {
        providerReady = identityProviderReady() === true;
      } catch {
        providerReady = false;
      }
      if (productionRuntime && !providerReady) {
        response.status(503).json({
          status: 'unready',
          database: 'connected',
          migrations: 'current',
          identityProvider: 'unavailable',
          migrationLevel: status.currentVersion,
        });
        return;
      }

      response.status(200).json({
        status: 'ready',
        database: 'connected',
        migrations: 'current',
        ...(productionRuntime ? {identityProvider: 'available'} : {}),
        migrationLevel: status.currentVersion,
        ...build,
      });
    } catch {
      response.status(503).json({status: 'unready', database: 'connected', migrations: 'unavailable'});
    }
  };

  const buildInfo = async (_request, response) => {
    noStore(response);
    let migrationLevel = null;
    try {
      const status = await migrationStatus(pool, {rootDir});
      migrationLevel = status.currentVersion;
    } catch {
      // Build metadata remains available when the database is not ready.
    }
    response.status(200).json({...build, migrationLevel});
  };

  const legacy = async (_request, response) => {
    noStore(response);
    if (!environment.DATABASE_URL) {
      response.status(200).json({status: 'ok', database: 'not_configured'});
      return;
    }
    try {
      await pool.query('select 1');
      response.status(200).json({status: 'ok', database: 'connected'});
    } catch {
      response.status(503).json({status: 'degraded', database: 'unreachable'});
    }
  };

  return {live, ready, buildInfo, legacy};
};

export const registerHealthRoutes = ({
  app,
  pool,
  rootDir,
  environment = process.env,
  migrationStatus = getMigrationStatus,
  identityProviderReady = isIdentityProviderAvailable,
  checkSessionLifetime,
}) => {
  const handlers = createHealthHandlers({pool, rootDir, environment, migrationStatus, identityProviderReady, checkSessionLifetime});
  app.get('/api/health/live', handlers.live);
  app.get('/api/health/ready', handlers.ready);
  app.get('/api/health/build', handlers.buildInfo);
  app.get('/api/health', handlers.legacy);
  return handlers;
};
