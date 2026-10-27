import React, { useState, useRef, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { getAuth, signInWithPopup, GoogleAuthProvider, createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile } from "firebase/auth";
import { ensureUserProfile, setProfileName } from "./firebaseservices";
import { announce } from "../services/announcer";
import Icon, { GoogleMark } from "./Icon";
import { usePageTitle } from "../services/uiHooks";
import { registerSignIn, reportAuthResult } from "../services/voiceContext";
import "./signin.css";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const AUTH_ERRORS = {
  "auth/email-already-in-use": "An account with this email already exists. Sign in instead.",
  "auth/weak-password": "The password is too weak. Use at least 8 characters.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "Incorrect email or password.",
  "auth/user-disabled": "This account has been disabled. Contact support.",
  "auth/too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
  "auth/popup-closed-by-user": "Google sign-in was cancelled.",
  "auth/popup-blocked": "The Google sign-in window was blocked. Allow pop-ups and try again.",
  "auth/network-request-failed": "Network error. Check your connection and try again.",
};

const messageFor = (error) => AUTH_ERRORS[error && error.code] || "Something went wrong. Please try again.";

function Field({ id, label, type = "text", error, registration, autoComplete, autoFocus }) {
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        className="input"
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        {...registration}
      />
      {error ? <p className="form-error" id={errorId}>{error.message}</p> : null}
    </div>
  );
}

function Sign() {
  const navigate = useNavigate();
  const [mode, setMode] = useState("login");
  const [formMessage, setFormMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const messageRef = useRef(null);
  const login = useForm();
  const signup = useForm();
  usePageTitle(mode === "login" ? "Sign in" : "Create an account");

  useEffect(() => {
    setFormMessage("");
  }, [mode]);

  const showError = (message) => {
    setFormMessage(message);
    announce(message);
    if (messageRef.current) messageRef.current.focus();
    reportAuthResult(false, message);
  };

  // Lets Zoro fill in a confirmed email address and move focus. Passwords are always typed here.
  const setLoginValue = login.setValue;
  const setSignupValue = signup.setValue;
  useEffect(() => {
    const focusLater = (id) => setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.focus();
    }, 60);
    return registerSignIn({
      setMode,
      setLoginEmail: (email) => {
        setMode("login");
        setTimeout(() => setLoginValue("email", email, { shouldValidate: true }), 30);
      },
      focusLoginPassword: () => focusLater("login-password"),
      focusGoogle: () => focusLater("google-sign-in"),
      setSignupField: (name, value) => {
        setMode("signup");
        setTimeout(() => setSignupValue(name, value, { shouldValidate: true }), 30);
      },
      focusSignupPassword: () => focusLater("signup-password"),
    });
  }, [setLoginValue, setSignupValue]);

  const emailLogin = async ({ email, password }) => {
    setBusy(true);
    try {
      await signInWithEmailAndPassword(getAuth(), email.trim(), password);
      announce("Signed in.");
      reportAuthResult(true);
      navigate("/");
    } catch (error) {
      showError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const newUserSubmit = async ({ newName, newEmail, newPassword, newConfirmPassword }) => {
    if (newPassword !== newConfirmPassword) {
      signup.setError("newConfirmPassword", { message: "The passwords do not match." });
      return;
    }
    setBusy(true);
    try {
      const { user } = await createUserWithEmailAndPassword(getAuth(), newEmail.trim(), newPassword);
      await updateProfile(user, { displayName: newName.trim() });
      // The auth listener may already have created the profile with a default name; set the real one.
      await ensureUserProfile(user, newName.trim());
      await setProfileName(user, newName.trim());
      announce("Account created. You are signed in.");
      reportAuthResult(true);
      navigate("/");
    } catch (error) {
      showError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const googleLogin = async () => {
    setBusy(true);
    try {
      // The profile is created by the auth listener in App.js for new Google users.
      await signInWithPopup(getAuth(), new GoogleAuthProvider());
      announce("Signed in with Google.");
      reportAuthResult(true);
      navigate("/");
    } catch (error) {
      showError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const errorsLogin = login.formState.errors;
  const errorsSignup = signup.formState.errors;

  const googleButton = (
    <button type="button" id="google-sign-in" className="btn btn-secondary btn-lg btn-block auth__google" onClick={googleLogin} disabled={busy}>
      <GoogleMark size={18} /> Sign in with Google
    </button>
  );

  return (
    <div className="auth">
      <aside className="auth__aside">
        <Link to="/" className="wordmark auth__wordmark"><span className="wordmark__text">VoiceCart</span><span className="visually-hidden"> home</span></Link>
        <div className="auth__stage" aria-hidden="true">
          <img className="auth__image" src="/images/prod11.png" alt="" width="447" height="559" />
        </div>
        <p className="auth__tagline">Considered pieces, <em>found by voice.</em></p>
      </aside>

      <div className="auth__panel">
        <div className="auth__card">
          <Link to='/' id='guestHome' className="auth__guest">
            <Icon name="arrowLeft" size={18} /> Continue to the store as a guest
          </Link>

          <div
            className={`auth__message${formMessage ? " banner banner--error" : ""}`}
            role="alert"
            tabIndex={-1}
            ref={messageRef}
          >
            {formMessage}
          </div>

          {mode === "login" ? (
            <form className="auth__form" id="login" onSubmit={login.handleSubmit(emailLogin)} noValidate aria-labelledby="login-title">
              <p className="eyebrow">Welcome back</p>
              <h1 className="auth__title" id="login-title">Sign in</h1>
              <Field id="login-email" label="Email address" type="email" autoComplete="email" autoFocus
                error={errorsLogin.email}
                registration={login.register("email", { required: "Enter your email address.", pattern: { value: EMAIL_PATTERN, message: "Enter a valid email address." } })} />
              <Field id="login-password" label="Password" type="password" autoComplete="current-password"
                error={errorsLogin.password}
                registration={login.register("password", { required: "Enter your password." })} />
              <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <p className="auth__divider"><span>or</span></p>
              {googleButton}
              <p className="auth__switch">
                New to VoiceCart?{" "}
                <button type="button" className="link-button" onClick={() => setMode("signup")}>
                  Create an account
                </button>
              </p>
            </form>
          ) : (
            <form className="auth__form" id="signUp" onSubmit={signup.handleSubmit(newUserSubmit)} noValidate aria-labelledby="signup-title">
              <p className="eyebrow">Join VoiceCart</p>
              <h1 className="auth__title" id="signup-title">Create your account</h1>
              <Field id="signup-name" label="Name" autoComplete="name" autoFocus
                error={errorsSignup.newName}
                registration={signup.register("newName", { required: "Enter your name.", maxLength: { value: 80, message: "The name is too long." } })} />
              <Field id="signup-email" label="Email address" type="email" autoComplete="email"
                error={errorsSignup.newEmail}
                registration={signup.register("newEmail", { required: "Enter your email address.", pattern: { value: EMAIL_PATTERN, message: "Enter a valid email address." } })} />
              <Field id="signup-password" label="Password (at least 8 characters)" type="password" autoComplete="new-password"
                error={errorsSignup.newPassword}
                registration={signup.register("newPassword", { required: "Enter a password.", minLength: { value: 8, message: "Use at least 8 characters." } })} />
              <Field id="signup-confirm" label="Confirm password" type="password" autoComplete="new-password"
                error={errorsSignup.newConfirmPassword}
                registration={signup.register("newConfirmPassword", { required: "Confirm your password." })} />
              <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
                {busy ? "Creating account…" : "Create account"}
              </button>
              <p className="auth__divider"><span>or</span></p>
              {googleButton}
              <p className="auth__switch">
                Already have an account?{" "}
                <button type="button" className="link-button" onClick={() => setMode("login")}>
                  Sign in
                </button>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default Sign;
