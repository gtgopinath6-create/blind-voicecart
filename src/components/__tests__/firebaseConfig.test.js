import { chooseFirebaseConfig } from "../firebase";

jest.mock("firebase/app", () => ({ initializeApp: () => ({}) }));
jest.mock("firebase/firestore", () => ({ getFirestore: () => ({}) }));

const defaults = { apiKey: "d", authDomain: "d", projectId: "default-project", storageBucket: "d", messagingSenderId: "d", appId: "d" };
const none = { apiKey: undefined, authDomain: undefined, projectId: undefined, storageBucket: undefined, messagingSenderId: undefined, appId: undefined };

test("without REACT_APP_FIREBASE_* variables the built-in project is used", () => {
    expect(chooseFirebaseConfig(none, defaults)).toBe(defaults);
});

test("a complete set of variables selects another project, such as staging", () => {
    const staging = { apiKey: "k", authDomain: "s.firebaseapp.com", projectId: "staging", storageBucket: "s.appspot.com", messagingSenderId: "1", appId: "a" };
    expect(chooseFirebaseConfig(staging, defaults)).toBe(staging);
});

test("a partial set fails loudly instead of mixing two projects", () => {
    expect(() => chooseFirebaseConfig({ ...none, projectId: "staging" }, defaults))
        .toThrow(/REACT_APP_FIREBASE_API_KEY.*REACT_APP_FIREBASE_MESSAGING_SENDER_ID, REACT_APP_FIREBASE_APP_ID/);
});
