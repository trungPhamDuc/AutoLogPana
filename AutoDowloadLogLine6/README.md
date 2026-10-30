# LWS Machine Event Downloader (Chrome extension)

Thư mục extension là `chrome-extension`. Các file Python và userscript Tampermonkey cũ đã được bỏ.

## Cài extension vào Chrome

1. Mở `chrome://extensions`.
2. Nếu đã cài bản cũ, bấm **Reload** trên extension trong danh sách.
3. Nếu cài lần đầu, bật **Developer mode** rồi chọn **Load unpacked** và chọn thư mục `chrome-extension` trong thư mục dự án.
4. Mở trang LWS **Machine Event** và đăng nhập như thường lệ.
5. Bấm biểu tượng extension trên đúng tab Machine Event, nhập khoảng ngày và nhấn **Start / tiếp tục**. Lần đầu, Chrome sẽ hỏi cấp quyền tải xuống cho extension; hãy chọn **Cho phép**. Extension bật tải nhiều tệp tự động cho riêng website hiện tại và xếp các file CSV vào thư mục theo ngày trong tên file, dạng `YYYY-MM-DD` (ví dụ `2026-10-01/20261001_NPM-01.csv`).

Mặc định hai ô ngày được điền sẵn ngày hôm qua. Để tự tải hằng ngày, mở đúng trang Machine Event (không phải trang Login hoặc menu chính) và bấm **Bật tự tải hằng ngày** một lần, sau đó cấp quyền được hỏi. Không cần bấm **Start** để chạy lịch; Start chỉ dành cho lượt tải thủ công. Extension lưu URL và tự mở tab Machine Event lúc 08:00 mỗi ngày nếu tab đã đóng, nhận biết trang hết phiên, đăng nhập, mở mục Machine Event từ menu rồi tải các machine number của ngày hôm trước. Khi trang Machine Event mở thành công, extension tự cập nhật URL lưu trong lịch. Nếu 08:00 bị lỡ, extension xếp một lượt chạy bù khi service worker được khởi động lại sau 08:00. Nếu bật lịch sau 08:00 và chưa hoàn tất hôm nay, extension cũng xếp một lượt bù. Chrome cần đang chạy. Bấm lại nút để tắt lịch. Popup lưu và hiển thị trạng thái lần gần nhất; trạng thái cũ hơn 7 ngày sẽ tự xóa. Extension giữ tối đa 1.000 sự kiện log chẩn đoán gần nhất; mở popup rồi bấm **Tải file log chẩn đoán** để tải JSON xem thời điểm báo thức, đăng nhập, lỗi và lượt bị bỏ qua.

Thông tin đăng nhập hiện được ghi trực tiếp trong `chrome-extension/content.js` để tự đăng nhập. Mật khẩu vì vậy là văn bản thường trong mã extension và có thể đọc được bởi người có quyền xem thư mục hoặc source extension; chỉ dùng trên máy cá nhân đáng tin cậy.

Nhấn **Start / tiếp tục** một lần. Extension tự chọn lần lượt từng machine number và ngày, bỏ qua máy `SPD2`, bấm nút xuất CSV rồi bấm lượt kế tiếp sau mỗi 15 giây, không chờ file trước tải xong. Nếu một lượt không bấm xuất được, lượt đó được ghi nhận là bỏ qua và extension tiếp tục máy kế tiếp. Các thư mục ngày được tạo bên trong vị trí tải xuống đang cài trong Chrome.

## Dừng

Mở popup extension và nhấn **Stop**. Lượt đang tải được để trình duyệt hoàn thành, các lượt tiếp theo dừng lại. **Start / tiếp tục** tiếp tục từ tiến độ đã lưu; **Reset** xóa tiến độ để bắt đầu khoảng ngày khác.

Sau khi Reload extension, tải lại tab Machine Event rồi mở popup và bấm Start một lần. Extension không khóa vào IP hay URL cụ thể. Nó chỉ được chèn vào tab đang chọn sau khi bạn bấm biểu tượng extension; vì vậy nếu trang LWS đổi IP hoặc đường dẫn, không cần sửa `manifest.json`. Sau khi đổi tab hoặc tải lại trang, bấm biểu tượng extension để kết nối lại và tiếp tục tiến độ đã lưu.
