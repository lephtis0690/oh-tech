function doGet(e) {
  return ContentService
    .createTextOutput("学習記録送信用Apps Scriptは動作しています。")
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const sessions = ss.getSheetByName("sessions");
  if (!sessions) {
    throw new Error("sessionsシートが見つかりません。");
  }

  sessions.appendRow([
    new Date(),
    data.studentId || "",
    data.grade || "",
    data.classNumber || "",
    data.studentNumber || "",
    data.mode || "",
    data.totalQuestions || 0,
    data.correctCount || 0,
    data.accuracy || 0,
    data.studySeconds || 0,
    JSON.stringify(data.categorySummary || {})
  ]);

  const answers = ss.getSheetByName("answers");
  if (answers && Array.isArray(data.answers)) {
    const rows = data.answers.map(answer => [
      new Date(),
      data.studentId || "",
      data.grade || "",
      data.classNumber || "",
      data.studentNumber || "",
      answer.questionId || "",
      answer.category || "",
      answer.selectedAnswer || "",
      answer.correctAnswer || "",
      answer.isCorrect ? "正解" : "不正解"
    ]);
    if (rows.length) {
      answers.getRange(answers.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ result: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}
