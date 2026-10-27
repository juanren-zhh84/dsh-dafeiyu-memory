export function createFakeContext() {
  const services = new Map();
  const disposers = [];
  return {
    disposers,
    get: (name) => services.get(name),
    reflect: { provide: (name, service) => services.set(name, service) },
    effect(setup) {
      const dispose = setup();
      disposers.push(dispose);
      return dispose;
    },
  };
}
