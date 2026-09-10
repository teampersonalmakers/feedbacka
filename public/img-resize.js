// 워크시트 사진을 OCR 로 보내기 전에 줄인다.
//
// Vercel 서버리스 요청 본문 한도가 4.5MB 라, base64(+33%)로 3.3MB 를 넘는 사진은
// 서버에 닿기도 전에 조용히 실패했다. UI 는 "10MB 까지"라고 써 있었다.
// 장변 2000px · JPEG 0.85 면 글자 인식 품질은 그대로고 보통 300~600KB 로 떨어진다.
//
// 작은 파일은 원본 그대로 보낸다. GIF 는 캔버스로 첫 프레임만 뽑는다.
window.pmShrinkImage = function (file, maxSide, quality) {
  maxSide = maxSide || 2000;
  quality = quality || 0.85;
  var SMALL = 1.5 * 1024 * 1024;

  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var w = img.naturalWidth, h = img.naturalHeight;
      var scale = Math.min(1, maxSide / Math.max(w, h));
      var needs = scale < 1 || file.size > SMALL || file.type === 'image/gif';

      if (!needs) {
        var r = new FileReader();
        r.onload = function () {
          var d = String(r.result);
          resolve({ dataUrl: d, base64: d.split(',')[1], mediaType: file.type,
                    width: w, height: h, bytes: file.size, resized: false });
        };
        r.onerror = function () { reject(new Error('이미지를 읽을 수 없습니다')); };
        r.readAsDataURL(file);
        return;
      }

      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';               // PNG 투명 배경 → 흰색 (JPEG 는 알파 없음)
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      var d = c.toDataURL('image/jpeg', quality);
      resolve({ dataUrl: d, base64: d.split(',')[1], mediaType: 'image/jpeg',
                width: c.width, height: c.height, bytes: Math.round((d.length - 23) * 0.75), resized: true });
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다')); };
    img.src = url;
  });
};
