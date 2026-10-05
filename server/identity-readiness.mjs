let providerAvailable = false;

export const createIdentityProviderReadinessMonitor = ({probe, onAvailabilityChange}) => {
  let latestStartedProbe = 0;
  return async () => {
    const probeId = ++latestStartedProbe;
    try {
      await probe();
      if (probeId === latestStartedProbe) onAvailabilityChange(true);
    } catch (error) {
      if (probeId === latestStartedProbe) onAvailabilityChange(false);
      throw error;
    }
  };
};

export const setIdentityProviderAvailability = (available) => {
  providerAvailable = available === true;
};

export const isIdentityProviderAvailable = () => providerAvailable;
