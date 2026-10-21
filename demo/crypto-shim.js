// Браузерная замена node:crypto для демо
module.exports = {
  randomInt: (n) => Math.floor(Math.random() * n),
  randomBytes: (n) => ({
    toString: () => Array.from({ length: n }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(''),
  }),
};
