const KEY = "t04-cart";
window.cart = { get: () => JSON.parse(localStorage.getItem(KEY) || "{}"), set: (c) => localStorage.setItem(KEY, JSON.stringify(c)) };
window.PRODUCTS = { mug: { name: "Blue Mug", price: 12 }, tin: { name: "Tea Tin", price: 8 }, pot: { name: "Clay Teapot", price: 34 } };
window.cartCount = () => Object.values(cart.get()).reduce((a, b) => a + b, 0);
