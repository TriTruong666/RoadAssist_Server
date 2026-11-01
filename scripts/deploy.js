const { execSync } = require("child_process");

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { stdio: "inherit" });
}

function getOutput(command) {
  return execSync(command, { encoding: "utf-8" }).trim();
}

console.log("============================================");
console.log("     KIỂM TRA VÀ DEPLOY PRODUCTION          ");
console.log("============================================");

try {
  // 1. Checkout main
  console.log("\n[1/5] Đang chuyển sang branch main...");
  run("git checkout main");

  // 2. Kiểm tra git status
  console.log("\n[2/5] Kiểm tra trạng thái working tree...");
  const status = getOutput("git status --porcelain");
  if (status) {
    console.error("\n[LỖI] Working tree chưa clean! Còn file chưa commit:");
    run("git status -s");
    console.error(
      "\nVui lòng commit hoặc stash các thay đổi trước khi deploy.",
    );
    process.exit(1);
  }
  console.log("[OK] Working tree sạch (clean).");

  // 3. Checkout production
  console.log("\n[3/5] Đang chuyển sang branch production...");
  run("git checkout production");

  // 4. Pull origin main
  console.log("\n[4/5] Đang pull từ origin main sang production...");
  run("git pull origin main");

  // 5. Push origin production
  console.log("\n[5/5] Đang push lên origin production...");
  run("git push origin production");

  console.log("Deploy thành công !!!");

  // Switch back to main
  console.log("\nĐang chuyển lại về branch main...");
  run("git checkout main");
} catch (error) {
  console.error("\n[LỖI] Quá trình deploy bị gián đoạn do có lỗi.");
  process.exit(1);
}
