"use client";

import { GoogleSignInButton } from "@/components/GoogleSignInButton";
import { GuestSignInButton } from "@/components/GuestSignInButton";
import { PasswordField } from "@/components/PasswordField";
import { auth, db } from "@/lib/firebase/client";
import { FirebaseError } from "firebase/app";
import {
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LionMark } from "@/components/LionMark";

const inputClass = "field-input";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<"login" | "forgot">("login");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await signInWithEmailAndPassword(auth, email, password);
      router.replace("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setSubmitting(true);

    try {
      const credential = await signInWithPopup(auth, new GoogleAuthProvider());

      // Google sign-in creates an auth account even for first-timers, so a
      // missing profile doc means they never signed up — send them to the
      // signup form (which needs their team number) instead of into the app.
      const profile = await getDoc(doc(db, "users", credential.user.uid));
      if (!profile.exists()) {
        await signOut(auth).catch(() => {});
        setError(
          "No account for that Google user yet — sign up first with your team number.",
        );
        return;
      }

      router.replace("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col md:flex-row">
      <div className="hazard-stripe relative flex flex-col justify-between overflow-hidden bg-maroon-700 px-8 py-10 text-white md:w-2/5 md:px-12 md:py-16">
        <div className="absolute inset-0 bg-maroon-700/85" />
        <div className="relative flex items-center gap-2.5">
          <LionMark className="h-9 w-9 text-white" />
          <span className="text-lg font-semibold tracking-tight">FRC Scouting</span>
        </div>
        <div className="relative mt-10 md:mt-0">
          <p className="stat text-xs uppercase tracking-widest text-maroon-100">
            Team 5806
          </p>
          <h1 className="mt-2 text-2xl font-semibold leading-tight md:text-3xl">
            Built for the pit, not the boardroom.
          </h1>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        {mode === "login" ? (
          <>
            <h1 className="text-2xl font-semibold text-graphite-900">Log in</h1>

            <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-graphite-700">Email</span>
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                />
              </label>
              <PasswordField
                label="Password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
              />

              {error && (
                <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="btn-primary mt-2"
              >
                {submitting ? "Logging in…" : "Log in"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setMode("forgot");
                }}
                className="text-center text-sm font-medium text-maroon-600 dark:text-maroon-400 hover:text-maroon-700 dark:hover:text-maroon-300"
              >
                Forgot password?
              </button>

              <div className="flex items-center gap-3 text-xs uppercase tracking-wider text-graphite-400">
                <span className="h-px flex-1 bg-graphite-200" />
                or
                <span className="h-px flex-1 bg-graphite-200" />
              </div>

              <GoogleSignInButton
                label="Continue with Google"
                onClick={() => void handleGoogle()}
                disabled={submitting}
              />
              <GuestSignInButton />
            </form>
          </>
        ) : (
          <ForgotPasswordForm onBack={() => setMode("login")} />
        )}

        <p className="mt-6 text-center text-sm text-graphite-500">
          Need an account?{" "}
          <Link href="/signup" className="font-medium text-maroon-600 dark:text-maroon-400 hover:text-maroon-700 dark:hover:text-maroon-300">
            Sign up
          </Link>
        </p>
      </div>
      </div>
    </main>
  );
}

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<"sent" | "error" | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setSubmitting(true);

    try {
      await sendPasswordResetEmail(auth, email);
      setResult("sent");
    } catch (err) {
      // Firebase's email enumeration protection means a nonexistent account
      // also resolves successfully — auth/user-not-found only fires if that
      // protection is ever disabled for this project, and we deliberately
      // don't reveal account existence either way.
      if (err instanceof FirebaseError && err.code === "auth/user-not-found") {
        setResult("sent");
      } else {
        setResult("error");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold text-graphite-900">Reset password</h1>
      <p className="mt-1 text-sm text-graphite-500">
        Enter your email and we&apos;ll send you a link to reset your password.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-graphite-700">Email</span>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </label>

        {result === "sent" && (
          <p className="rounded-md bg-graphite-50 px-3 py-2 text-sm text-graphite-700">
            If an account exists for that email, we&apos;ve sent a reset link.
            Please check your inbox and your spam.
          </p>
        )}
        {result === "error" && (
          <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
            Something went wrong. Please try again.
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="btn-primary mt-2"
        >
          {submitting ? "Sending…" : "Send reset link"}
        </button>

        <button
          type="button"
          onClick={onBack}
          className="text-center text-sm font-medium text-maroon-600 dark:text-maroon-400 hover:text-maroon-700 dark:hover:text-maroon-300"
        >
          Back to log in
        </button>
      </form>
    </>
  );
}
